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
import logging

import flood_engine
import road_flooding
import prevention_constants as C
import prevention_validation as V
import ai_candidates as AC
import ai_llm
import prevention_coverage as PCOV

logger = logging.getLogger(__name__)

# Mirrors the response side. The proposer placed ONE action per zone and
# stopped, so a whole prevention plan was 1-2 structures and the
# before/after barely moved -- a single 50m wall cannot shift a
# corridor-wide flood. Several ids in the SAME call multiplies what the
# plan actually builds without multiplying Gemini calls, which is the
# binding constraint on the free tier. Every id is still validated
# against the same real placement rules.
# 8, not 4. Gemini's free tier allows 4 calls a minute and every zone x
# action-type pair costs one, so the plan's real size is set by how much
# each CALL returns, not by how long we are willing to wait: at 4 picks
# a whole rainfall run fitted only 4 measures inside the time budget.
# Asking for more ids in the same call multiplies the plan without
# costing another request.
MAX_PICKS_PER_ACTION_TYPE = 8
MAX_ACTIONS_PER_ZONE = 3 * MAX_PICKS_PER_ACTION_TYPE
# Minimum spacing between two picks of the same action type, so the
# model cannot spend a plan on neighbouring points defending one spot.
MIN_PICK_SPACING_M = 150.0

# How many ranked options are worth ordering for pre-validation. The
# validator only ever gets through a few dozen inside its own budget
# (PREVALIDATION_BUDGET_S), and the farthest-point spread used to order
# the rest is O(n^3) -- run over a full thousand-point candidate list it
# stopped being a sort and became a hang.
RANKED_SHORTLIST_MAX = 120

# Pre-validation bounds (see run_prevention_proposer's own comment).
# TARGET is how many known-good options are enough to give the model a
# real choice without checking a whole 2,000-point candidate pool;
# BUDGET_S caps the time spent per action type, since embankment's
# full-line check is still ~2.9s versus ~0.03s for a single point.
PREVALIDATION_TARGET = 18
PREVALIDATION_BUDGET_S = 8.0


def _remaining_action_types(cause_type, already_tried):
    """Action types this cause type still has left to try for a zone."""
    ordered = C.CAUSE_TYPE_ACTION_WEIGHTS.get(cause_type) or list(C.ALL_ACTION_TYPES)
    return [a for a in ordered if a not in (already_tried or set())]


# Action types that physically change the ground -- the only ones that
# can take a building OUT of the flood and lower "buildings affected".
# desilt / clearDrains / warningGauge / greenBuffer are real measures
# with real benefits, but none of them raise or shield terrain, so a
# plan made only of those cannot move that number no matter how many
# are placed. SYNC: flood_engine.apply_all_terrain_actions +
# apply_local_protection (embankment raises; pond/widen/encroachment
# spend intercepted volume as local protection).
PROTECTIVE_ACTION_TYPES = ("retentionPond", "embankment", "removeEncroachment", "widenChannel")


def decide_action_type_for_zone(cause_type, already_tried=None, prefer_protective=False):
    """Next action type to try for this zone, in CAUSE_TYPE_ACTION_WEIGHTS
    (Part -1) order, skipping whatever's already been tried for this
    same zone. Not a hard restriction -- an unrecognized cause_type
    falls back to trying every real action type in PREVENTION_TOOLS
    order. Returns None once every action type has been tried.

    prefer_protective moves the first ground-changing type to the front
    when this zone actually contains buildings standing in water. A real
    drainage_failure run put desilt first (correctly -- it IS the
    scenario's primary measure), spent its whole time budget on four
    desilts, and never reached retentionPond, so the report showed
    "4 buildings affected" before AND after. The order is otherwise
    untouched; this only guarantees the plan tries the one kind of
    measure that could protect those buildings before it runs out of
    time.
    """
    already_tried = already_tried or set()
    ordered = list(C.CAUSE_TYPE_ACTION_WEIGHTS.get(cause_type) or list(C.ALL_ACTION_TYPES))
    if prefer_protective:
        protective = [a for a in ordered if a in PROTECTIVE_ACTION_TYPES and a not in already_tried]
        if protective:
            return protective[0]
    for action_type in ordered:
        if action_type not in already_tried:
            return action_type
    return None


def build_proposer_prompt(candidates, zone, action_type, rejection_context, max_picks=MAX_PICKS_PER_ACTION_TYPE):
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
            "Pick DIFFERENT candidate ids that avoid that problem."
        )

    return f"""You are planning real "{action_type}" prevention actions
from a fixed list of real candidate points, for this priority zone:
"{zone.get('description', 'priority zone')}"

Pick up to {max_picks} candidate ids that TOGETHER best protect this zone.

Some candidates say how many flood-exposed buildings they protect.
PREFER THOSE. A measure that protects nobody is worth less than one
that shields real buildings, however good its position looks.{retry_note}

One structure rarely protects a whole corridor. Choose points that are
SPREAD ALONG the channel so each one shields a different stretch --
several neighbouring points defend the same few buildings and waste the
plan. Fewer is fine if the zone genuinely only needs one. Never repeat
an id.

Candidates:
{candidates_json}

Return ONLY this JSON shape:
{{"candidate_ids": [0, 1], "parameters": {{}}, "reasoning": "short real reasoning"}}"""


def _validate_proposer_shape(parsed):
    """Accepts the multi-pick shape, and still accepts a bare
    candidate_id so a model answering in the older single-pick form is
    not treated as a failed call."""
    if not isinstance(parsed, dict):
        raise ValueError("proposer response is not an object")
    if "candidate_ids" in parsed:
        ids = parsed["candidate_ids"]
        if not isinstance(ids, list) or not ids:
            raise ValueError("'candidate_ids' must be a non-empty list")
        return
    if "candidate_id" not in parsed:
        raise ValueError("proposer response missing 'candidate_ids'")


def picked_ids(llm_result, max_picks):
    """The candidate ids this result chose, in order, de-duplicated."""
    raw = llm_result.get("candidate_ids")
    if raw is None:
        raw = [llm_result.get("candidate_id")]
    out = []
    for v in raw:
        if isinstance(v, bool) or not isinstance(v, int):
            continue
        if v not in out:
            out.append(v)
    return out[:max_picks]


def _rank_by_protection(cands, action_type, elevation, dem_bounds, water_level_m):
    """Order a validated shortlist by the real protection it buys.

    Two separate problems this solves, both of which showed up as a
    prevention plan that reported no measurable impact:

    1. generate_candidate_points walks the zone in scan order, so the
       first options that pass validation are typically all neighbours.
       Several neighbouring structures defend the same few buildings.

    2. Nothing previously connected a candidate to the buildings
       actually exposed to this flood. Measures got placed along the
       channel wherever a rule allowed, which is why plan protection
       coverage came out at 0% -- correct, and useless.

    So: greedy marginal coverage, exactly as the AI RESPONSE side ranks
    its candidates. Each pass takes the option protecting the most
    exposed buildings NOT already protected by something above it. Real
    reaches (prevention_coverage.action_protection_reach_m), real
    exposed-building list, no weighting invented here.

    Options that protect nobody are not dropped -- a desilting reach is
    still worth doing -- they simply fall below the ones that do, and
    are ordered by farthest-point spread among themselves.
    """
    if len(cands) <= 2:
        return list(cands)

    try:
        exposed = PCOV.at_risk_buildings(elevation, dem_bounds, water_level_m)
    except Exception:
        return _spread_out(cands)
    if not exposed:
        return _spread_out(cands)

    reach = PCOV.action_protection_reach_m(
        {"type": action_type, "params": _default_parameters(action_type, None)}
    )
    if reach <= 0:
        return _spread_out(cands)

    # Buildings standing IN the water, as opposed to merely inside the
    # freeboard band. These are the only ones a measure can take out of
    # the flood, so they are what the impact report's "buildings
    # affected" counts -- and they are weighted above the rest below.
    try:
        flooded = set(PCOV.flooded_buildings(elevation, dem_bounds, water_level_m))
    except Exception:
        flooded = set()
    flooded_idx = {j for j, pt in enumerate(exposed) if pt in flooded}

    cover = {}
    for i, c in enumerate(cands):
        cover[i] = {
            j for j, (blon, blat) in enumerate(exposed)
            if PCOV._distance_m(c["lon"], c["lat"], blon, blat) <= reach
        }
        # Put the real number in front of the model too. Ranking alone
        # only controls the ORDER of the shortlist; the model still
        # chose freely within it, so options protecting nobody were
        # picked as readily as options protecting seven households.
        # This is a measured count, not a hint.
        c["_cover"] = sorted(cover[i])
        if cover[i]:
            n_flooded = len(cover[i] & flooded_idx)
            c["descriptor"] = (
                f"{c.get('descriptor', '')} -- protects "
                f"{len(cover[i])} flood-exposed building"
                f"{'s' if len(cover[i]) != 1 else ''} within {round(reach)}m"
                + (f", {n_flooded} of them currently under water" if n_flooded else "")
            )

    ordered, taken, seen = [], set(), set()
    while len(ordered) < len(cands):
        best_i, best_gain = None, 0
        for i in range(len(cands)):
            if i in seen:
                continue
            new_cover = cover[i] - taken
            # A building already under water counts double. Both are
            # real buildings this measure would serve; the weighting
            # only decides which option is offered FIRST when two cover
            # the same number, and the one that can actually lower
            # "buildings affected" should win.
            gain = len(new_cover) + len(new_cover & flooded_idx)
            if gain > best_gain:
                best_i, best_gain = i, gain
        if best_i is None:
            break
        seen.add(best_i)
        taken |= cover[best_i]
        ordered.append(cands[best_i])

    # Everything that protects nobody new, spread so the model still
    # gets geographically distinct options to choose between. Bounded:
    # _spread_out is O(n^3) and this list can hold a thousand points, so
    # spreading it whole hung the whole request. Only as many as
    # pre-validation could ever look at are worth ordering.
    leftover = [c for i, c in enumerate(cands) if i not in seen]
    need = max(0, RANKED_SHORTLIST_MAX - len(ordered))
    return ordered + _spread_out(leftover[:need])


def _spread_out(cands):
    """Farthest-point ordering: each next entry is the one furthest from
    everything already chosen. Keeps the shortlist geographically
    diverse so several picks cover different ground."""
    remaining = list(cands)
    if len(remaining) <= 2:
        return remaining
    ordered = [remaining.pop(0)]
    while remaining:
        best_i, best_d = 0, -1.0
        for i, c in enumerate(remaining):
            d = min(V.distance_m(c["lon"], c["lat"], o["lon"], o["lat"]) for o in ordered)
            if d > best_d:
                best_i, best_d = i, d
        ordered.append(remaining.pop(best_i))
    return ordered


def call_proposer_llm(candidates, zone, action_type, rejection_context=None, deadline=None, max_picks=None):
    prompt = build_proposer_prompt(candidates, zone, action_type, rejection_context,
                                   max_picks or MAX_PICKS_PER_ACTION_TYPE)
    # max_retries lowered from 3: this already sits inside
    # run_prevention_proposer's own outer retry loop (max_retries below),
    # so the two multiplied together on the old values meant up to 3*4=12
    # real, rate-limited Gemini calls for ONE action type in ONE zone.
    return ai_llm.call_llm_json(prompt, validate_fn=_validate_proposer_shape, max_retries=1, deadline=deadline)


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
        # The size a user placing a pond BY HAND gets, not the bare
        # fallback constant. PlanWorkspace.js's retentionPond form
        # defaults to 10,000m2 x 3m; prevention_constants' 2,000m2 x 2m
        # is only the floor _build_terrain_args falls back to when a
        # payload carries no size at all. Proposing the smaller one made
        # every AI pond a fifth the size of the same tool used manually
        # -- and since a pond's real service reach is derived from its
        # radius (flood_engine.apply_local_protection), that shrank its
        # real protected area to a third.
        # SYNC: PlanWorkspace.js PREVENTION_TOOLS retentionPond formFields.
        params.setdefault("area_m2", 10000)
        params.setdefault("depth_m", 3)
    elif action_type == "widenChannel":
        params.setdefault("new_width_m", 8)
        params.setdefault("section_length_m", 50)
    return params


# PlanWorkspace.js's retentionPond form limits -- a proposed basin must
# stay inside the range a user could actually enter by hand.
# SYNC: PREVENTION_TOOLS retentionPond formFields (area 500-200000, depth 0.5-8).
POND_MAX_DEPTH_M = 8.0
POND_MIN_DEPTH_M = 3.0

# Freeboard the sized basin aims to clear the water by.
POND_SIZING_MARGIN_M = 0.25

# flood_engine.apply_local_protection spreads a pond's stored volume over
# a service zone of radius 2.5 x the pond radius, so the protection it
# provides works out to pond_depth / 6.25 -- INDEPENDENT of surface area
# (V = A*d, zone = pi*(2.5*sqrt(A/pi))^2 = 6.25*A, so V/zone = d/6.25).
# Widening a basin therefore buys nothing; only deepening it does.
_POND_PROTECTION_DIVISOR = 6.25


def _size_pond_for_flooded(candidate, parameters, elevation, dem_bounds, water_level_m):
    """Deepen a proposed basin to the depth it actually has to offset.

    A 3m basin yields 3/6.25 = 0.48m of protection, which cannot lift a
    building standing in 0.80m of water -- so every AI plan reported
    "9 buildings affected" before and after, correctly but uselessly.
    Sizing the basin to the shallowest flooded building it serves is the
    same judgement an engineer makes (you size a detention basin for the
    head you need), and stays inside the tool's own 8m limit. Nothing is
    relaxed: the deeper basin is what gets validated, simulated and
    added to the plan.
    """
    try:
        reach = PCOV.action_protection_reach_m({"type": "retentionPond", "params": parameters})
        flooded = PCOV.flooded_buildings(elevation, dem_bounds, water_level_m)
    except Exception:
        return parameters
    depths = []
    for blon, blat in flooded:
        if PCOV._distance_m(candidate["lon"], candidate["lat"], blon, blat) > reach:
            continue
        ground = flood_engine.sample_elevation_from_array(elevation, dem_bounds, blon, blat)
        if ground != ground or ground <= -1000:
            continue
        depths.append(water_level_m - ground)
    if not depths:
        return parameters
    # Plus a margin. Sizing to exactly the water depth breaks even --
    # ground + 0.80m of protection against 0.80m of water leaves the
    # building at precisely the water level, which still counts as
    # flooded. No engineer sizes a basin to break even either.
    needed_m = (min(depths) + POND_SIZING_MARGIN_M) * _POND_PROTECTION_DIVISOR
    out = dict(parameters)
    out["depth_m"] = round(min(POND_MAX_DEPTH_M, max(POND_MIN_DEPTH_M, needed_m)), 1)
    return out


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
                             existing_plan_actions=None, max_proposals=4, max_retries=2, deadline=None):
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

    # Last real LLM failure seen, so a run that proposes nothing purely
    # because the model was unreachable can report that instead of
    # looking like a successful empty result. See the check after the
    # zone loop.
    llm_error = None

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
        zone_accepted_count = 0

        # Does this zone actually contain buildings standing in water?
        # Only then is it worth spending the zone's first attempt on a
        # ground-changing measure rather than the scenario's own
        # top-ranked one.
        try:
            _bbox = zone.get("bbox") or []
            zone_has_flooded_buildings = bool(_bbox) and any(
                _bbox[0] <= blon <= _bbox[2] and _bbox[1] <= blat <= _bbox[3]
                for blon, blat in PCOV.flooded_buildings(elevation, dem_bounds, water_level_m)
            )
        except Exception:
            zone_has_flooded_buildings = False

        # Keep going after the first success instead of stopping there.
        # The old `while zone_proposal is None` ended the moment ONE
        # action was accepted, so an entire prevention plan was one or
        # two structures and the before/after barely moved. A real plan
        # combines several measures along the corridor.
        while True:
            if deadline is not None and _time.time() >= deadline:
                break
            if zone_accepted_count >= MAX_ACTIONS_PER_ZONE:
                break
            if len(proposals) + zone_accepted_count >= max_proposals:
                break
            # Lead with a ground-changing measure while this zone still
            # has buildings under water and nothing placed here yet can
            # shield them -- see decide_action_type_for_zone.
            prefer_protective = (
                zone_has_flooded_buildings
                and not any(a in PROTECTIVE_ACTION_TYPES for a in tried_action_types)
            )
            action_type = decide_action_type_for_zone(
                cause_type, tried_action_types, prefer_protective=prefer_protective)
            if action_type is None:
                break  # exhausted every action type for this zone
            tried_action_types.add(action_type)
            trace.append({"event": "action_type_start", "zone_index": zone_index, "action_type": action_type})

            candidates = AC.generate_candidate_points(action_type, zone["bbox"], waterways_geojson, buildings_geojson)
            candidates = AC.filter_out_overlapping(candidates, existing_plan_actions)
            if not candidates:
                trace.append({"event": "no_candidates", "zone_index": zone_index, "action_type": action_type})
                continue  # try the next action type for this zone

            # Pre-validate BEFORE asking the model to choose, so it only
            # ever sees candidates that already pass the real placement
            # rules. Previously the model picked blind, the pick was
            # validated, and a rejection cost another whole LLM call to
            # retry -- and for action types whose rules can never be met
            # by an on-waterway candidate (a retention pond can't sit
            # "0m from the nullah -- inside the channel itself"), EVERY
            # retry was doomed, burning the request's whole time budget
            # on an action type that could not succeed.
            #
            # This is only affordable because validation is now ~0.03s
            # instead of ~12s (see prevention_validation's geometry
            # cache + bbox pruning). Bounded two ways regardless -- stop
            # once enough valid options are found, and never spend more
            # than PREVALIDATION_BUDGET_S on one action type, since
            # embankment's full-line check is still much costlier than
            # a single point check.
            # Rank BEFORE pre-validating, not after. Pre-validation
            # stops at the first PREVALIDATION_TARGET that pass, in
            # whatever order the candidates arrived -- which is scan
            # order along the channel. Ranking the survivors afterwards
            # could only reorder twelve neighbours; ranking first means
            # the twelve that get validated are the twelve that protect
            # the most exposed buildings. The ranking itself is pure
            # distance arithmetic, so doing it on the full list is cheap
            # next to the validation it steers.
            candidates = _rank_by_protection(
                candidates, action_type, elevation, dem_bounds, water_level_m,
            )

            prevalid = []
            _pv_deadline = _time.time() + PREVALIDATION_BUDGET_S
            _pv_params = _default_parameters(action_type, None)
            for cand in candidates:
                if len(prevalid) >= PREVALIDATION_TARGET or _time.time() >= _pv_deadline:
                    break
                try:
                    ok, _reason = _validate_candidate_action(
                        action_type, cand, _pv_params, waterways_geojson,
                        buildings_geojson, roads_geojson, water_bodies_geojson,
                    )
                except Exception:
                    continue
                if ok:
                    prevalid.append(cand)

            if not prevalid:
                # Nothing here can pass the real rules -- move straight
                # to the next action type WITHOUT spending an LLM call.
                trace.append({
                    "event": "no_valid_candidates", "zone_index": zone_index,
                    "action_type": action_type, "checked": len(candidates),
                })
                continue

            # Already ranked above; validation preserved that order.
            candidates = prevalid

            rejection_context = None
            accepted_batch = []
            accepted_batch_points = []
            # Exposed buildings this action type's picks already protect,
            # so the spacing rule below can tell a redundant neighbour
            # from a second measure that shields different households.
            batch_covered = set()

            for attempt in range(max_retries):
                if deadline is not None and _time.time() >= deadline:
                    break
                # Share the remaining slots across the action types this
                # zone has not tried yet, instead of letting the first
                # type take everything. On a real drainage_failure run
                # desilt and clearDrains -- both 65m reach -- filled all
                # twenty slots before retentionPond, whose reach is 141m
                # and which protects far more, was ever reached: the plan
                # came out at 6% coverage while a mixed one hit 50%.
                # Order still follows CAUSE_TYPE_ACTION_WEIGHTS; this
                # only stops the front of that order starving the rest.
                remaining_slots = min(
                    MAX_ACTIONS_PER_ZONE - zone_accepted_count,
                    max_proposals - (len(proposals) + zone_accepted_count),
                )
                types_left = max(1, len(_remaining_action_types(cause_type, tried_action_types)) + 1)
                fair_share = -(-remaining_slots // types_left)  # ceil
                room = max(2, min(MAX_PICKS_PER_ACTION_TYPE, remaining_slots, fair_share))
                try:
                    llm_result = call_proposer_llm(candidates, zone, action_type, rejection_context,
                                                   deadline=deadline, max_picks=room)
                except Exception as e:
                    trace.append({"event": "llm_unreachable", "zone_index": zone_index, "action_type": action_type, "detail": str(e)[:200]})
                    logger.warning(
                        "proposer: LLM unreachable for zone %d action_type %s: %s: %s",
                        zone_index, action_type, type(e).__name__, e,
                    )
                    llm_error = e
                    break  # LLM totally unreachable for this action type -- try the next one

                # The model may choose SEVERAL points for this action
                # type in one call. Validate each independently and keep
                # every one that passes.
                by_id = {c["id"]: c for c in candidates}
                last_reason = None

                for cid in picked_ids(llm_result, room):
                    candidate = by_id.get(cid)
                    if candidate is None:
                        last_reason = "invalid candidate_id -- pick ids from the list"
                        continue
                    # Spacing, but coverage-aware. A flat "150m apart"
                    # rule assumes two nearby measures are redundant --
                    # true when nothing is behind them, wrong when the
                    # exposed buildings themselves sit closer together
                    # than that, which is exactly the case worth
                    # planning for. So a close pick is only rejected if
                    # it protects nobody the batch does not already
                    # protect.
                    cand_cover = set(candidate.get("_cover") or [])
                    too_close = any(
                        V.distance_m(candidate["lon"], candidate["lat"], a["lon"], a["lat"]) < MIN_PICK_SPACING_M
                        for a in accepted_batch_points
                    )
                    if too_close and not (cand_cover - batch_covered):
                        continue
                    parameters = _default_parameters(action_type, llm_result.get("parameters"))
                    if action_type == "retentionPond":
                        parameters = _size_pond_for_flooded(
                            candidate, parameters, elevation, dem_bounds, water_level_m)
                    ok, reason = _validate_candidate_action(
                        action_type, candidate, parameters, waterways_geojson,
                        buildings_geojson, roads_geojson, water_bodies_geojson,
                    )
                    if not ok:
                        last_reason = reason
                        trace.append({"event": "rejected", "zone_index": zone_index,
                                      "action_type": action_type, "reason": reason})
                        continue
                    accepted_batch.append((candidate, parameters, llm_result))
                    accepted_batch_points.append({"lon": candidate["lon"], "lat": candidate["lat"]})
                    batch_covered |= cand_cover
                    trace.append({
                        "event": "accepted", "zone_index": zone_index, "action_type": action_type,
                        "location": {"lon": candidate["lon"], "lat": candidate["lat"]},
                    })

                # Top up from the ranked shortlist. The model is asked
                # for up to `room` ids and routinely returns two, which
                # left most of a plan's capacity unused -- and the ids it
                # skipped are not junk: they are options that already
                # passed the same real placement rules and are ordered by
                # how many exposed buildings they protect. So after the
                # model has chosen, fill the remaining room with the
                # best-scoring options it did not take, each validated
                # individually like any other pick. Recorded as
                # "auto_topup" in the trace so the plan never presents a
                # deterministic fill as the model's own choice.
                if accepted_batch:
                    for candidate in candidates:
                        if len(accepted_batch) >= room:
                            break
                        if any(candidate is c for c, _p, _r in accepted_batch):
                            continue
                        cand_cover = set(candidate.get("_cover") or [])
                        if not (cand_cover - batch_covered):
                            continue  # protects nobody new -- not worth a slot
                        if any(
                            V.distance_m(candidate["lon"], candidate["lat"], a["lon"], a["lat"]) < MIN_PICK_SPACING_M
                            for a in accepted_batch_points
                        ) and not (cand_cover - batch_covered):
                            continue
                        parameters = _default_parameters(action_type, llm_result.get("parameters"))
                    if action_type == "retentionPond":
                        parameters = _size_pond_for_flooded(
                            candidate, parameters, elevation, dem_bounds, water_level_m)
                        ok, reason = _validate_candidate_action(
                            action_type, candidate, parameters, waterways_geojson,
                            buildings_geojson, roads_geojson, water_bodies_geojson,
                        )
                        if not ok:
                            continue
                        accepted_batch.append((candidate, parameters, llm_result))
                        accepted_batch_points.append({"lon": candidate["lon"], "lat": candidate["lat"]})
                        batch_covered |= cand_cover
                        trace.append({
                            "event": "auto_topup", "zone_index": zone_index,
                            "action_type": action_type,
                            "location": {"lon": candidate["lon"], "lat": candidate["lat"]},
                            "protects": len(cand_cover),
                        })
                    break
                rejection_context = last_reason or "no valid pick"
                continue

            # Commit EVERY accepted pick, not just the first. Each one
            # gets its own real before/after recomputation, so the plan
            # that comes back is several real structures whose combined
            # impact is visible in the comparison panel.
            for cand, params, res in accepted_batch:
                impact = compute_real_impact(
                    action_type, cand, params, elevation, dem_bounds,
                    water_level_m, waterways_geojson, before_stats, before_roads,
                )
                if impact is None:
                    continue
                proposals.append({
                    "action_type": action_type,
                    "location": {"lon": cand["lon"], "lat": cand["lat"]},
                    "parameters": params,
                    "real_impact": impact,
                    "ai_reasoning": res.get("reasoning"),
                    "zone_description": zone.get("description"),
                })
                zone_accepted_count += 1
                zone_proposal = proposals[-1]
                # Feed each chosen point into the overlap filter so
                # later action types -- and later zones -- can't
                # re-propose the same spot.
                existing_plan_actions.append({"lon": cand["lon"], "lat": cand["lat"]})

        if zone_proposal is not None:
            trace.append({"event": "zone_done", "zone_index": zone_index,
                          "actions": zone_accepted_count})
        else:
            trace.append({"event": "zone_skipped", "zone_index": zone_index})

    # Zero proposals is a legitimate, meaningful answer when the real
    # placement rules rejected every candidate (or none existed) -- the
    # trace says exactly which rule, and that still returns 200. It is
    # NOT a legitimate answer when the model was simply never reachable:
    # that used to surface as a successful "0 proposals" response,
    # indistinguishable from "your plan already covers everything". If
    # nothing was proposed AND an LLM call actually failed, re-raise so
    # the endpoint reports the real cause.
    if not proposals and llm_error is not None:
        raise llm_error

    return {"proposals": proposals, "trace": trace}
