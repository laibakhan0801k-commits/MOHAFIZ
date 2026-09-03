"""
AI PREVENTION PROPOSER -- Part 4 (agentic retry loop against real validators).

This is the core of the "propose, don't assert" principle: the LLM only
ever picks a candidate_id from a real, pre-generated list (Part 2,
ai_candidates.py) and suggests parameters; every proposal is checked
against the EXACT SAME validation rules a human click would face
(Part 1, prevention_validation.py), and every accepted proposal's
impact is a REAL before/after flood-extent recomputation reusing
flood_engine's real terrain-modification functions -- never an LLM
guess.
"""
import math
import json

import flood_engine
import road_flooding
import prevention_constants as C
import prevention_validation as V
import ai_candidates as AC
import ai_llm


def decide_action_type_for_zone(cause_type, already_tried=None):
    """Next action type to try for this zone, in CAUSE_TYPE_ACTION_WEIGHTS
    (Part -1) order, skipping whatever's already been tried for this
    same zone. Not a hard restriction -- an unrecognized cause_type
    falls back to trying every real action type in PREVENTION_TOOLS
    order. Returns None once every action type has been tried."""
    already_tried = already_tried or set()
    ordered = C.CAUSE_TYPE_ACTION_WEIGHTS.get(cause_type) or list(C.ALL_ACTION_TYPES)
    for action_type in ordered:
        if action_type not in already_tried:
            return action_type
    return None


def build_proposer_prompt(candidates, zone, action_type, rejection_context):
    """Deliberately a single flat object response shape ({"candidate_id",
    "parameters", "reasoning"}), NOT a list -- the same empirically-
    grounded lesson from Part 3 (see ai_hazard_analyst.py's
    run_hazard_analyst docstring): a flat object is what actually
    parses reliably against qwen/qwen3.6-27b's real JSON mode."""
    candidates_json = json.dumps([{"id": c["id"], "descriptor": c["descriptor"]} for c in candidates])
    retry_note = ""
    if rejection_context:
        retry_note = (
            f"\nYour previous proposal was rejected: \"{rejection_context}\". "
            "Pick a DIFFERENT candidate id that avoids that problem."
        )

    return f"""You are proposing ONE real "{action_type}" prevention action
from a fixed list of real candidate points, for this priority zone:
"{zone.get('description', 'priority zone')}"

Pick the candidate id that best addresses this zone.{retry_note}

Candidates:
{candidates_json}

Return ONLY this JSON shape:
{{"candidate_id": 0, "parameters": {{}}, "reasoning": "short real reasoning"}}"""


def _validate_proposer_shape(parsed):
    if not isinstance(parsed, dict) or "candidate_id" not in parsed:
        raise ValueError("proposer response missing 'candidate_id'")


def call_proposer_llm(candidates, zone, action_type, rejection_context=None, deadline=None):
    prompt = build_proposer_prompt(candidates, zone, action_type, rejection_context)
    return ai_llm.call_llm_json(prompt, validate_fn=_validate_proposer_shape, max_retries=3, deadline=deadline)


def _default_parameters(action_type, llm_parameters):
    """Fills in real defaults for anything the LLM didn't specify --
    the SAME defaults main.py's _build_terrain_args already uses, so a
    proposal's real_impact is computed with the exact numbers that
    would actually be applied if the user adds it to their plan."""
    params = dict(llm_parameters or {})
    if action_type == "embankment":
        params.setdefault("length_m", 50)
        params.setdefault("height", 1.5)
    elif action_type == "retentionPond":
        params.setdefault("area_m2", C.RETENTION_POND_DEFAULT_AREA_M2)
        params.setdefault("depth_m", C.RETENTION_POND_DEFAULT_DEPTH_M)
    elif action_type == "widenChannel":
        params.setdefault("new_width_m", 8)
        params.setdefault("section_length_m", 50)
    return params


def _validate_candidate_action(action_type, candidate, parameters, waterways_geojson,
                                buildings_geojson, roads_geojson, water_bodies_geojson):
    """Runs the candidate through the EXACT SAME validation a human
    click would face (Part 1) -- embankment gets the full-line sampling
    check (validate_embankment_line), everything else gets the
    generalized config-driven check (check_point_constraints)."""
    if action_type == "embankment":
        length_m = float(parameters.get("length_m", 50))
        line_coords = V.build_embankment_line(candidate["lon"], candidate["lat"], length_m, waterways_geojson)
        if line_coords is None:
            return False, "couldn't determine a wall direction from the waterway geometry at this point"
        return V.validate_embankment_line(line_coords, waterways_geojson, buildings_geojson, roads_geojson)

    config = C.ACTION_VALIDATION_CONFIG.get(action_type, {})
    if not config:
        # Waterway-snap-only actions (desilt/clearDrains/warningGauge) --
        # already guaranteed to be ON the waterway network, since Part 2
        # only ever generates candidates for these sampled along it.
        return True, None
    ok, reason, _extra = V.check_point_constraints(
        candidate["lon"], candidate["lat"], config,
        waterways_geojson, buildings_geojson, roads_geojson, water_bodies_geojson,
    )
    return ok, reason


def compute_real_impact(action_type, candidate, parameters, elevation, dem_bounds,
                         water_level_m, waterways_geojson, before_stats, before_roads):
    """
    Fast, REAL before/after check for ONE candidate action -- reuses
    apply_line_raise / apply_area_lower / apply_line_lower +
    compute_flood_extent_on_array + get_flooded_roads_on_array exactly
    as already proven in scripts/test_embankment.py and
    _run_prevention_sim (main.py). `before_stats`/`before_roads` are
    passed in ALREADY COMPUTED -- they don't depend on the candidate, so
    a proposer loop trying many candidates across many zones never
    recomputes the same before-state twice.

    Returns None if the action's geometry couldn't be built (e.g. no
    usable waterway direction for an embankment at this exact point) --
    the caller treats that the same as a rejected candidate.
    """
    line_coords = None
    if action_type == "embankment":
        length_m = float(parameters.get("length_m", 50))
        line_coords = V.build_embankment_line(candidate["lon"], candidate["lat"], length_m, waterways_geojson)
        if line_coords is None:
            return None
        height = float(parameters.get("height", 1.5))
        modified = flood_engine.apply_line_raise(elevation, dem_bounds, line_coords, height, buffer_m=15)
    elif action_type == "retentionPond":
        area = float(parameters.get("area_m2", C.RETENTION_POND_DEFAULT_AREA_M2))
        depth = float(parameters.get("depth_m", C.RETENTION_POND_DEFAULT_DEPTH_M))
        radius = math.sqrt(area / math.pi)
        modified = flood_engine.apply_area_lower(elevation, dem_bounds, candidate["lon"], candidate["lat"], radius, depth)
    elif action_type == "widenChannel":
        new_width = float(parameters.get("new_width_m", 8))
        section_length_m = float(parameters.get("section_length_m", 50))
        half_deg = (section_length_m / 2) / 111320
        line_coords = [
            [candidate["lon"], candidate["lat"] - half_deg],
            [candidate["lon"], candidate["lat"] + half_deg],
        ]
        modified = flood_engine.apply_line_lower(elevation, dem_bounds, line_coords, C.WIDEN_CHANNEL_DEPTH_M, buffer_m=new_width / 2)
    elif action_type == "removeEncroachment":
        modified = flood_engine.apply_area_lower(
            elevation, dem_bounds, candidate["lon"], candidate["lat"],
            C.ENCROACHMENT_REMOVAL_RADIUS_M, C.ENCROACHMENT_REMOVAL_DEPTH_M,
        )
    else:
        # desilt / clearDrains / greenBuffer / warningGauge: no terrain
        # modification (capacity-only or non-physical, same as
        # main.py's _build_terrain_args) -- honestly reports ZERO
        # single-action flood-extent change rather than fabricating one;
        # their real benefit is a runoff-coefficient/capacity effect
        # that only shows up for volume-based causes across a WHOLE
        # plan (flood_engine.compute_capacity_gain), not a single
        # terrain-modification action in isolation.
        modified = elevation

    after_mask, after_stats = flood_engine.compute_flood_extent_on_array(modified, water_level_m)
    after_roads = road_flooding.get_flooded_roads_on_array(water_level_m, modified, dem_bounds)

    pixels_saved = max(0, before_stats["flooded_pixels"] - after_stats["flooded_pixels"])
    return {
        "flooded_percent_before": before_stats["flooded_percent"],
        "flooded_percent_after": after_stats["flooded_percent"],
        "roads_cut_before": before_roads["flooded_edge_count"],
        "roads_cut_after": after_roads["flooded_edge_count"],
        "roads_saved": max(0, before_roads["flooded_edge_count"] - after_roads["flooded_edge_count"]),
        "pixels_saved": pixels_saved,
        "area_saved_m2": round(pixels_saved * flood_engine.PIXEL_AREA_M2, 0),
        "line_coords": line_coords,
    }


def run_prevention_proposer(priority_zones, cause_type, elevation, dem_bounds, water_level_m,
                             waterways_geojson, buildings_geojson, roads_geojson, water_bodies_geojson,
                             existing_plan_actions=None, max_proposals=4, max_retries=3, deadline=None):
    """
    For each priority zone (in order), tries action types from
    CAUSE_TYPE_ACTION_WEIGHTS[cause_type] until one produces an
    accepted, real-impact-computed proposal, or the zone's action types
    are exhausted. Every accepted proposal's `real_impact` is genuine
    terrain physics (compute_real_impact), never an LLM guess -- the
    LLM only ever picked which real candidate point and which
    real-default-filled parameters to try.

    Partial results beat a failed request: a zone that never produces
    an accepted proposal (every action type's candidates all get
    rejected, or the LLM is unreachable) is simply skipped -- this can
    return fewer than max_proposals proposals, including zero. Same
    principle for time: `deadline` (an absolute time.time() cutoff, set
    by the /ai/prevention/suggest endpoint's overall ~30-40s request
    budget -- Part 6) is checked before starting each new zone and each
    new retry attempt; once passed, whatever proposals already succeeded
    are returned immediately rather than pushing on and risking the
    whole request timing out with nothing to show for it.

    Returns {"proposals": [...], "trace": [...]} -- `trace` is a REAL
    event log of what actually happened this request (zone_start,
    action_type_start, no_candidates, rejected + real reason, accepted,
    llm_unreachable, zone_done/zone_skipped), for the frontend's live
    progress display (Part 7) to render. It is not a fabricated demo
    sequence -- every line in it is something that genuinely occurred
    during this exact call.
    """
    import time as _time

    existing_plan_actions = list(existing_plan_actions or [])
    proposals = []
    # Real events only -- every entry here is something that actually
    # happened during THIS request (a real candidate rejected for a
    # real reason, a real proposal accepted), never a fabricated
    # "demo" trace. The frontend's progress log is built from this,
    # not invented client-side.
    trace = []

    # Computed ONCE -- doesn't depend on any candidate/action, so every
    # zone/attempt below reuses it instead of recomputing the same
    # before-state repeatedly.
    before_mask, before_stats = flood_engine.compute_flood_extent_on_array(elevation, water_level_m)
    before_roads = road_flooding.get_flooded_roads_on_array(water_level_m, elevation, dem_bounds)

    for zone_index, zone in enumerate(priority_zones):
        if len(proposals) >= max_proposals:
            break
        if deadline is not None and _time.time() >= deadline:
            break

        trace.append({"event": "zone_start", "zone_index": zone_index, "zone_description": zone.get("description")})

        tried_action_types = set()
        zone_proposal = None

        while zone_proposal is None:
            if deadline is not None and _time.time() >= deadline:
                break
            action_type = decide_action_type_for_zone(cause_type, tried_action_types)
            if action_type is None:
                break  # exhausted every action type for this zone
            tried_action_types.add(action_type)
            trace.append({"event": "action_type_start", "zone_index": zone_index, "action_type": action_type})

            candidates = AC.generate_candidate_points(action_type, zone["bbox"], waterways_geojson, buildings_geojson)
            candidates = AC.filter_out_overlapping(candidates, existing_plan_actions)
            if not candidates:
                trace.append({"event": "no_candidates", "zone_index": zone_index, "action_type": action_type})
                continue  # try the next action type for this zone

            rejection_context = None
            accepted_candidate = None
            accepted_parameters = None
            accepted_llm_result = None

            for attempt in range(max_retries):
                if deadline is not None and _time.time() >= deadline:
                    break
                try:
                    llm_result = call_proposer_llm(candidates, zone, action_type, rejection_context, deadline=deadline)
                except Exception as e:
                    trace.append({"event": "llm_unreachable", "zone_index": zone_index, "action_type": action_type, "detail": str(e)[:200]})
                    break  # LLM totally unreachable for this action type -- try the next one

                candidate = next((c for c in candidates if c["id"] == llm_result.get("candidate_id")), None)
                if candidate is None:
                    rejection_context = "invalid candidate_id -- pick one from the list"
                    trace.append({"event": "rejected", "zone_index": zone_index, "action_type": action_type, "reason": rejection_context})
                    continue

                parameters = _default_parameters(action_type, llm_result.get("parameters"))
                ok, reason = _validate_candidate_action(
                    action_type, candidate, parameters, waterways_geojson, buildings_geojson,
                    roads_geojson, water_bodies_geojson,
                )
                if ok:
                    accepted_candidate = candidate
                    accepted_parameters = parameters
                    accepted_llm_result = llm_result
                    trace.append({
                        "event": "accepted", "zone_index": zone_index, "action_type": action_type,
                        "location": {"lon": candidate["lon"], "lat": candidate["lat"]},
                    })
                    break
                rejection_context = reason
                trace.append({"event": "rejected", "zone_index": zone_index, "action_type": action_type, "reason": reason})

            if accepted_candidate is not None:
                impact = compute_real_impact(
                    action_type, accepted_candidate, accepted_parameters, elevation, dem_bounds,
                    water_level_m, waterways_geojson, before_stats, before_roads,
                )
                if impact is not None:
                    zone_proposal = {
                        "action_type": action_type,
                        "location": {"lon": accepted_candidate["lon"], "lat": accepted_candidate["lat"]},
                        "parameters": accepted_parameters,
                        "real_impact": impact,
                        "ai_reasoning": accepted_llm_result.get("reasoning"),
                        "zone_description": zone.get("description"),
                    }

        if zone_proposal is not None:
            proposals.append(zone_proposal)
            trace.append({"event": "zone_done", "zone_index": zone_index})
            # Feed this zone's chosen point into the overlap filter for
            # every subsequent zone too, so two zones can't
            # independently propose overlapping actions.
            existing_plan_actions.append({
                "lon": zone_proposal["location"]["lon"],
                "lat": zone_proposal["location"]["lat"],
            })
        else:
            trace.append({"event": "zone_skipped", "zone_index": zone_index})

    return {"proposals": proposals, "trace": trace}
