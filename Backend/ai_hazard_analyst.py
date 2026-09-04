"""
AI PREVENTION PROPOSER -- Hazard Analyst (Part 3, LLM call #1).

Reads REAL simulation stats -- assembled from the exact same
flood_engine / road_flooding functions /flood and /prevention/simulate
already call, not a new calculation path -- and asks the model to
identify priority zones. The model must only reference facility names
that actually appear in the real input; validate_hazard_response()
strips out anything it invents before this ever reaches the Proposer or
the user.
"""
import json
import logging

import flood_engine
import road_flooding
import ai_llm

# Propagates to uvicorn's own handler, so per-zone LLM failures are
# visible in the terminal running the server instead of vanishing.
logger = logging.getLogger(__name__)


def get_current_simulation_stats(water_level_m):
    """
    Real simulation stats for a given water level, in the same field
    shape /prevention/simulate's before/after stats already use
    (flooded_percent, roads_cut, buildings_affected, avg_depth_m,
    max_depth_m) plus affected_facilities (from /flood's shape, via
    flood_engine.list_affected_facilities -- /prevention/simulate
    doesn't compute that itself, so it's added here). No separate
    calculation path: every number below comes from the same real
    functions those two endpoints already call.
    """
    elevation, _valid = flood_engine.load_dem()
    bounds = flood_engine.get_dem_bounds()

    mask, flood_stats = flood_engine.compute_flood_extent_on_array(elevation, water_level_m)
    roads = road_flooding.get_flooded_roads_on_array(water_level_m, elevation, bounds)
    depth_stats = flood_engine.compute_depth_stats_on_array(elevation, water_level_m)
    buildings_affected = flood_engine.count_affected_buildings_on_array(elevation, bounds, water_level_m)
    affected_facilities = flood_engine.list_affected_facilities(water_level_m)

    return {
        "water_level_m": water_level_m,
        "flooded_percent": flood_stats["flooded_percent"],
        "roads_cut": roads["flooded_edge_count"],
        "buildings_affected": buildings_affected,
        "avg_depth_m": depth_stats["avg_depth_m"],
        "max_depth_m": depth_stats["max_depth_m"],
        "affected_facilities": affected_facilities,
        "flooded_bbox": flood_engine.get_flooded_bbox(mask),
    }


def _validate_single_zone_shape(parsed):
    """Cheap structural check before the semantic name-filtering pass
    below -- raises if the model returned something call_llm_json's
    retry loop should treat as a failed attempt (e.g. missing bbox
    entirely, or a malformed one)."""
    if not isinstance(parsed, dict) or "bbox" not in parsed or "description" not in parsed:
        raise ValueError("zone response is missing 'bbox' or 'description'")
    bbox = parsed["bbox"]
    if not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox)):
        raise ValueError("zone bbox is not [west, south, east, north]")


def build_single_zone_prompt(simulation_stats, zone_number, total_zones, already_covered_facility_names):
    """
    One zone per call, not a JSON array of zone objects -- see
    run_hazard_analyst()'s docstring for why: this shape empirically
    measured ~87% success (7/8) against qwen/qwen3.6-27b's real JSON
    mode, versus the array-of-objects shape's 0-33% across every
    variant tested (full/trimmed facility lists, flat vs nested bbox,
    system+user message split -- see scripts/test_hazard_analyst.py and
    the ad-hoc diagnostics run alongside it).
    """
    # Facility names in non-Latin scripts (Urdu/Arabic names are common
    # in this corridor's real OSM data) reproducibly make Groq's
    # json_object mode return an empty failed_generation for
    # qwen/qwen3.6-27b -- confirmed directly: the identical prompt with
    # only those facilities removed succeeds every time, with them
    # included it fails every time (scripts/test_response_hazard_reader.py's
    # investigation, real water_level_m=553 river_overflow data). Dropping
    # them from the PROMPT only (not from simulation_stats itself) is
    # safe: the model can only ever reference a name it was shown, and
    # validate_hazard_response's real-name check isn't affected since
    # these names simply never appear in its output either.
    ascii_facilities = [f for f in simulation_stats["affected_facilities"] if f["name"].isascii()]
    facilities_json = json.dumps(
        [{"name": f["name"], "amenity": f["amenity"]} for f in ascii_facilities]
    )
    exclusion_note = ""
    if already_covered_facility_names:
        exclusion_note = (
            "\nDo NOT propose a zone centered on these already-covered facilities: "
            + json.dumps(already_covered_facility_names)
            + ". Pick a genuinely DIFFERENT priority area."
        )
    urgency = "the SINGLE most urgent" if zone_number == 1 else f"the next most urgent (#{zone_number} of up to {total_zones})"

    return f"""You are analyzing a REAL flood simulation result for the
Nullah Leh / Korang corridor. Identify {urgency} priority zone that
needs prevention action.

CRITICAL: only reference facility names that appear in the data below.
Never invent a name that isn't in this list.{exclusion_note}

Flooded area: {simulation_stats['flooded_percent']}%
Roads cut: {simulation_stats['roads_cut']}
Buildings affected: {simulation_stats['buildings_affected']}
Affected facilities: {facilities_json}
Avg depth: {simulation_stats['avg_depth_m']}m
Max depth: {simulation_stats['max_depth_m']}m

Return ONLY this JSON shape:
{{"description": "short real description", "bbox": [west, south, east, north], "affected_facility_names": ["must be from the real list above"]}}"""


def validate_hazard_response(response, simulation_stats):
    """Reject/strip anything the LLM's output references that isn't
    actually in simulation_stats -- catches hallucinated facility names
    before they reach the Proposer or the user. Also clamps each zone's
    bbox to the real DEM bounds, since a model-proposed bbox slightly
    outside the modeled area would otherwise make generate_candidate_points
    (Part 2) silently return zero candidates for that zone."""
    real_names = {f["name"] for f in simulation_stats["affected_facilities"]}
    dem_bounds = None
    try:
        import flood_engine as _fe
        dem_bounds = _fe.get_dem_bounds()
    except Exception:
        pass

    for zone in response["priority_zones"]:
        zone["affected_facility_names"] = [
            n for n in zone.get("affected_facility_names", []) if n in real_names
        ]
        if dem_bounds is not None:
            w, s, e, n = dem_bounds
            bw, bs, be, bn = zone["bbox"]
            # Normalize (swap) west/east and south/north FIRST, THEN
            # clamp each bound independently against the real DEM
            # extent. Doing the swap and the clamp in one combined
            # expression (the original version of this line) silently
            # collapsed an inverted bbox (a real one the model returned:
            # north < south) into a degenerate zero-height box instead
            # of repairing it -- caught in scripts/test_ai_proposer.py
            # when a zone with that bbox produced zero real candidates.
            zw, ze = min(bw, be), max(bw, be)
            zs, zn = min(bs, bn), max(bs, bn)
            zone["bbox"] = [max(w, zw), max(s, zs), min(e, ze), min(n, zn)]

    return response


def run_hazard_analyst(simulation_stats, num_zones=3, deadline=None):
    """
    Makes `num_zones` SEPARATE single-zone LLM calls rather than one
    call asking for a JSON array of zone objects.

    This is a real, evidence-based design decision, not the original
    plan: the array-of-objects shape ({"priority_zones": [...]})
    consistently failed Groq's server-side JSON validator for
    qwen/qwen3.6-27b -- 0/15 across the full-facilities-list, trimmed-
    list, flattened-bbox, and system+user-message-split variants tried
    (scripts/test_hazard_analyst.py plus follow-up diagnostics run in
    the same session). A single flat zone object succeeded 7/8 times
    against the identical real data. Each call is told which facilities
    earlier zones already covered, so it picks a genuinely different
    area rather than repeating itself.

    Partial results beat a failed request: if some zone calls fail even
    after their own retries, the ones that succeeded are still
    returned -- this can legitimately return fewer than num_zones
    zones, including zero. Same principle for time: `deadline` (an
    absolute time.time() cutoff shared with the Proposer stage by the
    /ai/prevention/suggest endpoint's overall time budget -- Part 6) is
    checked before starting each new zone call; without this, a run of
    several 3-retry zone calls in a row (each retry can take up to
    timeout_s=15s) could blow well past the endpoint's own stated
    budget with nothing capping it, exactly the gap a real end-to-end
    test caught before this was added.
    """
    import time

    zones = []
    covered_names = []
    errors = []
    for i in range(num_zones):
        if deadline is not None and time.time() >= deadline:
            logger.warning("hazard analyst: time budget reached, stopping after %d/%d zone calls", i, num_zones)
            break
        prompt = build_single_zone_prompt(simulation_stats, i + 1, num_zones, covered_names)
        try:
            zone = ai_llm.call_llm_json(prompt, validate_fn=_validate_single_zone_shape, max_retries=3, deadline=deadline)
        except Exception as ex:
            # Previously a bare `except Exception: continue` with no
            # logging. That silently converted a TOTAL LLM outage (an
            # expired key, or -- the real case this was caught on -- a
            # Groq 429 daily-token-quota rejection) into an empty
            # priority_zones list, which the endpoint then returned as a
            # perfectly successful 200. The UI could only report it as
            # "0 priority zones identified from this simulation", which
            # reads as "your scenario has no hazards" rather than "the
            # AI never ran". Record the real error and keep going, so a
            # single bad zone still doesn't sink the whole request.
            logger.warning(
                "hazard analyst: zone %d/%d failed: %s: %s",
                i + 1, num_zones, type(ex).__name__, ex,
            )
            errors.append(ex)
            continue
        zones.append(zone)
        covered_names.extend(zone.get("affected_facility_names", []))

    # Partial results still beat a failed request (unchanged): if ANY
    # zone came back, return what succeeded. But zero zones plus at
    # least one real error is not a real "no hazards found" answer --
    # it means the analyst never got an answer at all, so surface the
    # actual cause instead of an empty-but-successful response.
    if not zones and errors:
        raise errors[-1]

    return validate_hazard_response({"priority_zones": zones}, simulation_stats)
