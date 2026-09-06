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
import math

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


# ai_candidates.generate_candidate_points only samples a waterway every
# spacing_m=30m. A real live run confirmed this in practice: 2 real
# zones, both correctly described as being along a real waterway
# ("along the main Nullah Leh channel" / "along the Nullah Leh
# corridor"), both returned zero candidates for every action type tried.
# A separate local check (same waterway/building data, the FULL DEM
# extent as the bbox) found 2,000+ real candidates for every one of
# those action types -- so the data and the candidate generator are not
# the problem. The zone bbox Gemini returned was simply narrower than
# the 30m sampling gap, so it could contain a real stretch of the
# waterway and still miss every sampled point along it.
#
# 150m (5x the sampling spacing) is enough margin to make that miss
# very unlikely regardless of the waterway's angle through the box.
# A "priority zone" for a corridor-scale flood is a district, not a
# doorstep. At 150m the model's own bbox drove everything and coverage
# swung wildly run to run -- one run returned a corridor-wide zone and
# the plan reached 45% of at-risk buildings, the next returned a box
# around a single hospital and the same plan reached 10%. Padding to a
# real neighbourhood scale makes the candidate pool (and therefore the
# plan) stable regardless of how tightly the model happens to draw the
# box. Still clamped to the real DEM extent, so this can never invent
# ground that is not modelled.
MIN_ZONE_SIZE_M = 1500.0


def _pad_bbox_to_min_size(bbox, dem_bounds, min_size_m):
    """Expands `bbox` around its own center, in each dimension that is
    narrower than `min_size_m` in real meters, then re-clamps to
    `dem_bounds` -- padding must never push a zone outside modeled
    ground. Leaves an already-large-enough bbox untouched."""
    w, s, e, n = bbox
    dw, ds, de, dn = dem_bounds
    center_lon = (w + e) / 2
    center_lat = (s + n) / 2

    m_per_deg_lon = 111320.0 * math.cos(math.radians(center_lat))
    m_per_deg_lat = 111320.0

    width_m = (e - w) * m_per_deg_lon
    height_m = (n - s) * m_per_deg_lat

    if width_m < min_size_m and m_per_deg_lon > 0:
        half_deg = (min_size_m / 2) / m_per_deg_lon
        w, e = center_lon - half_deg, center_lon + half_deg
    if height_m < min_size_m:
        half_deg = (min_size_m / 2) / m_per_deg_lat
        s, n = center_lat - half_deg, center_lat + half_deg

    return [max(dw, w), max(ds, s), min(de, e), min(dn, n)]


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
            clamped = [max(w, zw), max(s, zs), min(e, ze), min(n, zn)]
            zone["bbox"] = _pad_bbox_to_min_size(clamped, dem_bounds, MIN_ZONE_SIZE_M)

    return response


# Furthest a locally-protective prevention measure can be placed from
# the channel and still be legal: retentionPond's own maxWaterwayDistance
# (prevention_constants.ACTION_VALIDATION_CONFIG). Exposed buildings
# beyond this plus a measure's own reach cannot be protected by ANY
# valid prevention action, so a zone drawn around them would be a zone
# the proposer could never serve.
_MAX_MEASURE_OFFSET_M = 100.0


def _exposure_zone(simulation_stats, existing_zones):
    """A deterministic priority zone around the real buildings this
    flood exposes -- appended only when the model's own zones don't
    already reach any of them.

    The Analyst picks zones from flooded AREA, which is the right way to
    find where the water is but not where the damage is: on a real run
    its two zones sat on the widest part of the floodplain while every
    exposed building sat elsewhere, so the Proposer placed sixteen
    perfectly valid measures that protected nobody (0% coverage). This
    adds one zone drawn from the exposed buildings themselves.

    Nothing here is invented: the buildings come from
    prevention_coverage.at_risk_buildings (the same DEM-sample test
    flood_engine already uses to count affected buildings), and the zone
    is only offered around buildings a legal measure could actually
    reach. Returns None when there is nothing to add.
    """
    try:
        import prevention_coverage
        import prevention_validation as _V
        from shapely.geometry import Point as _Point

        elevation, _valid = flood_engine.load_dem()
        dem_bounds = flood_engine.get_dem_bounds()
        water_level_m = simulation_stats["water_level_m"]
        waterways = flood_engine.load_waterways()

        exposed = prevention_coverage.at_risk_buildings(elevation, dem_bounds, water_level_m)
        if not exposed:
            return None

        # Only buildings a valid measure could actually be placed near.
        reach = prevention_coverage.action_protection_reach_m(
            {"type": "retentionPond", "params": {"area": 10000}}
        )
        servable = []
        for lon, lat in exposed:
            d = _V.nearest_line_distance_m(_Point(lon, lat), waterways)
            if d is not None and d <= _MAX_MEASURE_OFFSET_M + reach:
                servable.append((lon, lat))
        if not servable:
            return None

        # Densest cluster: the servable building with the most other
        # servable buildings within one zone-width of it.
        half_deg_lat = (MIN_ZONE_SIZE_M / 2) / 111320.0

        def _near(a, b):
            return prevention_coverage._distance_m(a[0], a[1], b[0], b[1]) <= MIN_ZONE_SIZE_M / 2

        anchor = max(servable, key=lambda p: sum(1 for q in servable if _near(p, q)))
        cluster = [q for q in servable if _near(anchor, q)]
        # Skip only if a zone the model already chose covers MOST of
        # that cluster. The first version of this check bailed out as
        # soon as any single exposed building fell inside any zone,
        # which on a real run meant one incidental building suppressed
        # the zone drawn around the other seven.
        for zone in existing_zones:
            bbox = zone.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            w, s_, e, n = bbox
            inside = sum(1 for lon, lat in cluster if w <= lon <= e and s_ <= lat <= n)
            if inside >= 0.6 * len(cluster):
                return None

        clon = sum(p[0] for p in cluster) / len(cluster)
        clat = sum(p[1] for p in cluster) / len(cluster)
        half_deg_lon = half_deg_lat / max(math.cos(math.radians(clat)), 1e-9)

        dw, ds_, de, dn = dem_bounds
        bbox = [
            max(dw, clon - half_deg_lon), max(ds_, clat - half_deg_lat),
            min(de, clon + half_deg_lon), min(dn, clat + half_deg_lat),
        ]
        return {
            "bbox": _pad_bbox_to_min_size(bbox, dem_bounds, MIN_ZONE_SIZE_M),
            "description": (
                f"{len(cluster)} flood-exposed buildings clustered here, "
                "within reach of a legal prevention measure"
            ),
            "reason": (
                "Identified directly from the simulation: these buildings sit at or "
                f"below {simulation_stats['water_level_m']}m + "
                f"{prevention_coverage.AT_RISK_FREEBOARD_M}m freeboard, and are close "
                "enough to the channel for a prevention measure to protect them."
            ),
            "affected_facility_names": [],
            "derived": "exposed_buildings",
        }
    except Exception as ex:  # never let this optional extra sink a real run
        logger.warning("hazard analyst: exposure zone skipped: %s: %s", type(ex).__name__, ex)
        return None


def run_hazard_analyst(simulation_stats, num_zones=2, deadline=None):
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

    num_zones default lowered from 3 to 2 after switching to Gemini:
    the free tier caps requests at 5/minute for gemini-3.6-flash, and
    this Hazard Analyst call is only the FIRST stage -- the Proposer/
    Strategist that follows makes several more real calls per zone on
    top of it, all sharing the same per-minute budget. One fewer zone
    here leaves more of that shared budget for the stage that actually
    turns a zone into a real proposal.
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
            # max_retries lowered from 3: on Gemini's free tier each
            # retry is a real, rate-limited API call (5/minute total,
            # shared across every zone and the Proposer that follows).
            # 1 retry still recovers from a transient failure without
            # spending most of the per-minute budget on one zone alone.
            zone = ai_llm.call_llm_json(prompt, validate_fn=_validate_single_zone_shape, max_retries=1, deadline=deadline)
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

    response = validate_hazard_response({"priority_zones": zones}, simulation_stats)

    # Make sure at least one zone sits where the flood actually exposes
    # buildings -- see _exposure_zone. Appended after validation because
    # this zone is built from real geometry, not from model output, so
    # it has nothing to validate against a facility list.
    extra = _exposure_zone(simulation_stats, response["priority_zones"])
    if extra is not None:
        # FIRST, not last. The Proposer works through zones in order
        # against a shared wall-clock budget, so a zone appended at the
        # end gets whatever time the others left it -- and this is the
        # one zone guaranteed to contain buildings worth protecting.
        response["priority_zones"].insert(0, extra)

    return response
