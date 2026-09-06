"""
Response-side multi-agent AI comparison -- Part 2, Agent 2: Strategist.

Proposes ONE real response action per uncovered hazard zone (from Part 1,
ai_response_hazard_reader.py), from a fixed, real, pre-generated
candidate list (ai_response_candidates.py). Every proposal is checked
against the EXACT SAME validation a human click would face
(response_validation.py's VALIDATORS), retried with real rejection
feedback on failure, and its impact is REAL coverage math -- never an
LLM guess. Structurally this is the same agentic retry loop as
ai_proposer.py's run_prevention_proposer; only the domain (response
coverage vs. terrain modification) differs.
"""
import time as _time

import ai_response_candidates as RC
import response_validation as RV
from response_validation import DEFAULT_WARNING_RADIUS_M, DEFAULT_EVAC_RADIUS_M
import ai_llm
import ai_response_evaluator as _EV
import response_validation_rainfall as _RVR
import response_validation_drainage as _RVD
import response_validation_dam as _RVDAM
import logging

logger = logging.getLogger(__name__)

# Fixed try-order for river_overflow -- evacuationZone first because
# reliefMedicalPost's real validation REQUIRES an existing evacuation
# zone nearby (response_validation.validate_relief_medical_post), so a
# zone can't produce a usable relief post before an evac zone exists
# somewhere near it (either already in the user's plan, or proposed
# earlier this same run -- see run_response_strategist below).
# reliefMedicalPost moved up from LAST to third. It still has to come
# after evacuationZone (its own validation requires one nearby), but at
# the end of the list it was simply never reached: a real run placed
# 8 actions and stopped on the time budget before relief's turn, so
# relief/medical coverage stayed at 0% and the report's verdict line --
# which quotes the WORST category -- kept reading "100% of at-risk
# buildings are outside relief camp / medical reach" even when
# evacuation was at 42% and warning at 48%. Relief has valid candidates
# (4 of 275 at 545m); it was an ordering problem, not a placement one.
RIVER_OVERFLOW_ACTION_ORDER = ["evacuationZone", "warningPoint", "reliefMedicalPost", "boatLaunch", "closeRoad"]


SUPPORTED_CAUSE_TYPES = ("river_overflow", "rainfall", "drainage_failure", "dam_release")
# How many points the model may choose for ONE action type in ONE call.
#
# Previously it picked exactly one, so a zone got at most one pump, one
# overflow marker, one evacuation zone -- and the impact report barely
# moved: a real drainage-failure run treated 1% of the risk area and
# left "100% of flagged overflow points still unwarned", because one
# marker cannot warn six points. Asking for several ids in the SAME
# call multiplies what a plan actually covers WITHOUT multiplying the
# number of Gemini calls, which is the binding constraint on the free
# tier. Every id is still checked against the same real validation.
MAX_PICKS_PER_ACTION_TYPE = 6


def action_order_for(cause_type):
    """The real action list for this scenario -- the same set the manual
    map offers for it, never a mix. Each scenario's rules live in its own
    validation module (river_overflow in response_validation.py,
    rainfall in response_validation_rainfall.py)."""
    if cause_type == "rainfall":
        return _RVR.ACTION_ORDER
    if cause_type == "drainage_failure":
        return _RVD.ACTION_ORDER
    if cause_type == "dam_release":
        return _RVDAM.ACTION_ORDER
    return RIVER_OVERFLOW_ACTION_ORDER


def validators_for(cause_type):
    if cause_type == "rainfall":
        return _RVR.VALIDATORS
    if cause_type == "drainage_failure":
        return _RVD.VALIDATORS
    if cause_type == "dam_release":
        return _RVDAM.VALIDATORS
    return RV.VALIDATORS


def coverage_reach_for(cause_type, action_type):
    # Rank at the radius the plan will actually be PLACED at (see
    # _default_parameters) -- ranking at the small form default while
    # placing at the planned radius would score candidates on a circle
    # that is not the one drawn on the map.
    if action_type in ("evacuationZone", "rainEvacZone", "damEvacZone"):
        return PLANNED_EVAC_RADIUS_M
    if action_type in ("warningPoint", "rainWarning", "damWarningPoint"):
        return PLANNED_WARNING_RADIUS_M
    if cause_type == "rainfall":
        return _RVR.COVERAGE_REACH_M.get(action_type, 0)
    if cause_type == "drainage_failure":
        return _RVD.COVERAGE_REACH_M.get(action_type, 0)
    if cause_type == "dam_release":
        return _RVDAM.COVERAGE_REACH_M.get(action_type, 0)
    return RV.action_coverage_radius_m({"type": action_type})


def decide_action_type_for_zone(already_tried=None, cause_type="river_overflow"):
    already_tried = already_tried or set()
    for action_type in action_order_for(cause_type):
        if action_type not in already_tried:
            return action_type
    return None


def _remaining_action_types(cause_type, already_tried):
    """Action types this scenario still has left to try for a zone."""
    return [a for a in action_order_for(cause_type) if a not in (already_tried or set())]


def build_strategist_prompt(candidates, zone, action_type, rejection_context, max_picks=MAX_PICKS_PER_ACTION_TYPE):
    import json
    candidates_json = json.dumps([{"id": c["id"], "descriptor": c["descriptor"]} for c in candidates])
    retry_note = ""
    if rejection_context:
        retry_note = (
            f"\nYour previous proposal was rejected: \"{rejection_context}\". "
            "Pick a DIFFERENT candidate id that avoids that problem."
        )

    return f"""You are planning real "{action_type}" emergency response actions
from a fixed list of real candidate points, for this priority hazard zone:
"{zone.get('description', 'priority zone')}"

Pick up to {max_picks} candidate ids that TOGETHER best cover this zone.{retry_note}

One action rarely covers a whole zone. Choose points that are SPREAD OUT
so each one reaches buildings the others do not -- picking several
neighbours wastes the plan. Prefer candidates that protect the most
people: where a descriptor says how many buildings it covers, treat a
higher number as better. Putting an action where nobody lives helps no
one, however deep the water is.

Fewer is fine if the zone genuinely only needs one. Never repeat an id.

Candidates:
{candidates_json}

The "reasoning" is shown to an emergency planner next to these actions
on the map, so make it concrete and about THESE places: what is there,
who they protect, and why here rather than nearby. One or two sentences,
no restating ids.

Return ONLY this JSON shape:
{{"candidate_ids": [0, 1], "parameters": {{}}, "reasoning": "short real reasoning"}}"""


def _validate_strategist_shape(parsed):
    """Accepts the multi-pick shape, and still accepts a bare
    candidate_id so a model that answers in the older single-pick form
    is not treated as a failed call."""
    if not isinstance(parsed, dict):
        raise ValueError("strategist response is not an object")
    if "candidate_ids" in parsed:
        ids = parsed["candidate_ids"]
        if not isinstance(ids, list) or not ids:
            raise ValueError("'candidate_ids' must be a non-empty list")
        return
    if "candidate_id" not in parsed:
        raise ValueError("strategist response missing 'candidate_ids'")


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


def call_strategist_llm(candidates, zone, action_type, rejection_context=None, deadline=None, max_picks=None):
    prompt = build_strategist_prompt(candidates, zone, action_type, rejection_context,
                                     max_picks or MAX_PICKS_PER_ACTION_TYPE)
    # max_retries lowered from 3 -- same reasoning as ai_proposer.py's
    # call_proposer_llm: this sits inside run_response_strategist's own
    # outer retry loop (max_retries below), and the two multiplied
    # together on the old values meant up to 12 real, rate-limited
    # Gemini calls for ONE action type in ONE zone.
    return ai_llm.call_llm_json(prompt, validate_fn=_validate_strategist_shape, max_retries=1, deadline=deadline)


# How many candidates to score, and how many of the best to actually
# offer the model. Scoring is real coverage maths, so it is bounded both
# by count and by wall-clock time.
# A real response plan uses several complementary actions in the same
# priority area, not one. Bounded so a single zone can't consume the
# whole request's LLM budget -- the remaining zones still get a turn.
# Must cover EVERY action type, not a subset. At 3 the loop stopped
# after evacuationZone/warningPoint/closeRoad and never reached
# boatLaunch or reliefMedicalPost -- and those two are the ONLY things
# that feed the rescue-staging and relief/medical coverage numbers (see
# ai_response_evaluator: rescue_covered comes from boat_launches,
# relief_covered from relief_posts). So the impact report could never
# move off "100% of at-risk buildings are outside rescue-staging reach"
# no matter how good the plan was -- those metrics were structurally
# locked at 0%. Derived from the action list so adding a new action
# type can never silently re-introduce the same cap.
# Room for EVERY action type to place its full set of picks in one
# zone (largest list is rainfall's 6 types x MAX_PICKS_PER_ACTION_TYPE).
# At 6 the first two action types used the whole per-zone budget and
# boatLaunch / reliefMedicalPost were never reached in ANY zone, so
# rescue and relief coverage stayed at 0% no matter how many proposals
# the plan produced.
MAX_ACTIONS_PER_ZONE = 6 * MAX_PICKS_PER_ACTION_TYPE

# Extra wall-clock allowed AFTER the LLM budget is spent, used only for
# the deterministic fill below (candidate ranking + the real validators,
# no API calls). Without it the zone loop exits the instant the budget
# ends and the action types that never got a turn are simply missing
# from the plan -- which is how road closures ended up absent from every
# real river_overflow run.
FILL_GRACE_S = 25.0

# Most placements the deterministic fill will add for any one action
# type -- enough to make the category real in the plan, not enough for
# it to dominate what the model actually chose.
FILL_MAX_PER_ACTION_TYPE = 3


COVERAGE_SCAN_LIMIT = 400
COVERAGE_KEEP_TOP = 20
COVERAGE_SCAN_BUDGET_S = 12.0


def rank_candidates_by_coverage(action_type, candidates, ctx):
    """Score candidates by how many real at-risk buildings they'd
    actually cover, keep the best, and SAY the number in each
    descriptor.

    Without this the model chose blind. The descriptors it saw carried
    only depth ("Flooded point, 26.0m deep"), never coverage -- so it
    optimised for the one signal it had and repeatedly picked the
    deepest water, which is exactly where nobody lives. Measured on one
    real zone: of 1,263 evacuation-zone candidates, 430 covered ZERO
    buildings while the best covered 74 each. That is how a run could
    end with a valid, accepted zone and still report "0 buildings
    covered / 0% of at-risk buildings covered" in the impact report.

    Only affects WHICH real candidates are offered and how they are
    described -- every one still comes from the same real generated
    list, and the pick is still validated exactly as before. The model
    is being shown better information, not given new powers.
    """
    # Score against the SAME at-risk building set the Impact Report
    # measures (ai_response_evaluator.river_overflow_at_risk_buildings),
    # not "all buildings nearby". Otherwise the strategist optimises a
    # different number than the one the report shows, and a placement
    # can look good here while moving the report 0%.
    #
    # This matters most for boatLaunch and reliefMedicalPost. They were
    # previously left unranked, on the assumption that access/snap rules
    # site them well enough -- but a placement can be perfectly valid
    # and still have no at-risk buildings inside its service reach. A
    # real run proved it: a validated boat launch left rescue-staging
    # coverage at exactly 0%.
    reach = coverage_reach_for(ctx.get("cause_type", "river_overflow"), action_type)
    if not reach:
        return candidates

    try:
        # Each scenario has its own definition of "at risk": river
        # overflow uses the modelled flood extent, rainfall uses the
        # terrain-derived drainage-risk zones. Rank against whichever
        # set THIS scenario's impact report will measure.
        if ctx.get("cause_type") == "rainfall":
            at_risk = _RVR.at_risk_buildings(ctx["buildings_geojson"])
        else:
            at_risk = _EV.river_overflow_at_risk_buildings(
                ctx["depth_grid"], ctx["depth_meta"], ctx["buildings_geojson"]
            )
    except Exception:
        return candidates
    if not at_risk:
        return candidates

    def covered_set(c):
        """Indices of the at-risk buildings this candidate reaches."""
        lat, lon = c["lat"], c["lon"]
        hit = set()
        for i, pt in enumerate(at_risk):
            if RV.distance_m(lon, lat, pt["lon"], pt["lat"]) <= reach:
                hit.add(i)
        return hit

    deadline = _time.time() + COVERAGE_SCAN_BUDGET_S
    scored = []
    for c in candidates[:COVERAGE_SCAN_LIMIT]:
        if _time.time() >= deadline:
            break
        try:
            scored.append((covered_set(c), c))
        except Exception:
            continue

    if not scored:
        return candidates
    if not any(cov for cov, _c in scored):
        # Nothing here covers anything -- ranking adds no information,
        # so don't mislead the model with "covers 0 buildings" on every
        # option. Hand back the original list untouched.
        return candidates

    # GREEDY MARGINAL COVERAGE, not simply "top N by coverage".
    #
    # Taking the N highest-coverage points returned N NEIGHBOURS: in a
    # real run the 15-option shortlist for boatLaunch was entirely
    # inside one dense cluster, so every option covered the same 41
    # buildings and rescue-staging coverage was pinned at 8% no matter
    # how many the model picked. The prompt asked for spread-out picks
    # while the list offered none.
    #
    # So each slot goes to whichever candidate adds the most buildings
    # NOT already covered by the options above it. The shortlist becomes
    # a set that genuinely tiles the risk area, and the descriptor
    # states each option's own marginal contribution so the model is
    # choosing on the same basis.
    remaining = list(scored)
    chosen = []
    covered_so_far = set()
    while remaining and len(chosen) < COVERAGE_KEEP_TOP:
        best_i, best_gain = None, 0
        for i, (cov, _c) in enumerate(remaining):
            gain = len(cov - covered_so_far)
            if gain > best_gain:
                best_i, best_gain = i, gain
        if best_i is None:
            break  # nothing left adds anything new
        cov, c = remaining.pop(best_i)
        covered_so_far |= cov
        chosen.append((best_gain, len(cov), c))

    if not chosen:
        return candidates

    out = []
    for new_id, (gain, total, c) in enumerate(chosen):
        c = dict(c)
        c["id"] = new_id  # ids must stay contiguous for the prompt
        base = c.get("descriptor") or ""
        extra = f" — covers {total} buildings" if gain == total else f" — covers {total} buildings ({gain} not reached by the options above)"
        c["descriptor"] = base + extra
        out.append(c)
    return out


# Radii the AI plans at, where the action has a user-settable one.
#
# These are deliberately larger than each tool's own FORM default
# (evacuationZone 300m, warningPoint 400m). Those defaults are what a
# human gets before typing anything, not a limit -- the real form
# accepts up to 2000m for an evacuation zone and 3000m for warning
# coverage, so everything here stays well inside what a manual
# placement could legitimately choose.
#
# The reason is measured, not cosmetic: at the form defaults a whole
# plan covered ~10% evacuation / ~23% warning of 515 at-risk buildings,
# because a 300m circle over a corridor-scale flood reaches very few of
# them. At these radii the same placements reach ~21% / ~70%. A
# corridor-wide release warning genuinely does carry further than 400m,
# so the larger figure is also the more realistic plan -- but it IS a
# planning assumption, stated here rather than buried.
PLANNED_EVAC_RADIUS_M = 800       # form allows up to 2000
PLANNED_WARNING_RADIUS_M = 1200   # form allows up to 3000


def _default_parameters(action_type, llm_parameters):
    params = dict(llm_parameters or {})
    if action_type == "warningPoint":
        params.setdefault("coverage_radius_m", PLANNED_WARNING_RADIUS_M)
    elif action_type == "evacuationZone":
        params.setdefault("radius_m", PLANNED_EVAC_RADIUS_M)
    elif action_type == "rainWarning":
        params.setdefault("coverage_radius_m", PLANNED_WARNING_RADIUS_M)
    elif action_type in ("rainEvacZone", "damEvacZone"):
        params.setdefault("radius_m", PLANNED_EVAC_RADIUS_M)
    elif action_type == "damWarningPoint":
        params.setdefault("coverage_radius_m", PLANNED_WARNING_RADIUS_M)
    return params


def compute_real_coverage_impact(action_type, candidate, parameters, ctx):
    """Real coverage math for one accepted proposal -- what this action
    actually reaches, not an LLM guess. Reuses the exact same real
    building/depth-grid primitives response_validation's validators
    already read."""
    if action_type == "warningPoint":
        cov = RV.warning_coverage(candidate["lat"], candidate["lon"], parameters.get("coverage_radius_m", DEFAULT_WARNING_RADIUS_M), ctx["buildings_geojson"])
        return {"buildings_covered": cov["building_count"], "estimated_people": cov["estimated_people"], "radius_m": cov["radius_m"]}
    if action_type == "evacuationZone":
        stats = RV.evacuation_zone_stats(candidate["lat"], candidate["lon"], parameters.get("radius_m", DEFAULT_EVAC_RADIUS_M), ctx)
        return {
            "buildings_covered": stats["building_count"], "max_depth_m": stats["max_depth_m"],
            "flooded_percent": stats["flooded_percent"], "hospitals_covered": stats["hospitals"], "radius_m": parameters.get("radius_m", DEFAULT_EVAC_RADIUS_M),
        }
    if action_type == "closeRoad":
        depth = RV.depth_at_point(candidate["lat"], candidate["lon"], ctx["depth_grid"], ctx["depth_meta"]) or 0.0
        return {"road_depth_m": round(depth, 1)}
    if action_type == "boatLaunch":
        scan = RV.scan_depth_near(candidate["lat"], candidate["lon"], RV.RULES["BOAT_WATER_ADJACENCY_M"], ctx["depth_grid"], ctx["depth_meta"])
        return {"max_depth_nearby_m": round(scan["max_depth_m"], 1), "service_reach_m": 500}
    if action_type == "reliefMedicalPost":
        return {"service_reach_m": 800}
    return {}


def run_response_strategist(uncovered_zones, cause_type, ctx, max_proposals=4, max_retries=2, deadline=None):
    """
    For each uncovered hazard zone (Part 1's output), tries action types
    in RIVER_OVERFLOW_ACTION_ORDER until one produces an accepted,
    real-coverage-computed proposal, or the zone's action types are
    exhausted. Mirrors run_prevention_proposer's structure exactly --
    same partial-results-beat-a-failed-request principle, same
    deadline checks before every zone/attempt, same real trace log.

    Only river_overflow is supported (response_validation.py only ports
    that scenario's rules so far).

    ctx is mutated in place: an accepted evacuationZone proposal is
    appended to ctx["existing_evac_zones"] immediately, so a LATER
    zone's reliefMedicalPost candidates can real-validate against a
    zone this SAME run proposed, not only ones already in the user's
    saved plan.

    Returns {"proposals": [...], "trace": [...]}.
    """
    # Scenarios whose real rules are actually ported. action_order_for /
    # validators_for dispatch on this, so adding a scenario means adding
    # its validation module and listing it here -- never a silent
    # fallthrough to another scenario's physics.
    if cause_type not in SUPPORTED_CAUSE_TYPES:
        return {"proposals": [], "trace": [{"event": "unsupported_cause_type", "cause_type": cause_type}]}

    proposals = []
    trace = []
    existing_actions = []  # for the overlap filter, grows as zones succeed
    # See the check after the zone loop -- distinguishes "the real rules
    # rejected everything" (a genuine 200 answer) from "the model was
    # never reachable" (an error that used to masquerade as one).
    llm_error = None

    for zone_index, zone in enumerate(uncovered_zones):
        if len(proposals) >= max_proposals:
            break
        if deadline is not None and _time.time() >= deadline:
            break

        trace.append({"event": "zone_start", "zone_index": zone_index, "zone_description": zone.get("description")})

        tried_action_types = set()
        zone_proposal = None
        zone_accepted_count = 0

        # Keep going after the first success instead of stopping there.
        # The old `while zone_proposal is None` loop ended the moment ONE
        # action was accepted, and since evacuationZone is first in
        # RIVER_OVERFLOW_ACTION_ORDER, every zone produced exactly one
        # evacuation zone and nothing else -- not a real response plan,
        # and it capped coverage at whatever a single zone could reach.
        # A real plan combines several action types (warn, evacuate,
        # close roads, stage boats, site relief) in the same area, so
        # this now tries every action type for the zone and keeps each
        # one that passes, bounded by MAX_ACTIONS_PER_ZONE, the caller's
        # max_proposals, and the deadline.
        while True:
            if deadline is not None and _time.time() >= deadline:
                break
            if zone_accepted_count >= MAX_ACTIONS_PER_ZONE:
                break
            if len(proposals) + zone_accepted_count >= max_proposals:
                break
            action_type = decide_action_type_for_zone(tried_action_types, cause_type)
            if action_type is None:
                break
            tried_action_types.add(action_type)
            trace.append({"event": "action_type_start", "zone_index": zone_index, "action_type": action_type})

            candidates = RC.generate_candidates(action_type, zone["bbox"], ctx)
            candidates = RC.filter_out_overlapping(candidates, existing_actions)
            if not candidates:
                trace.append({"event": "no_candidates", "zone_index": zone_index, "action_type": action_type})
                continue

            candidates = rank_candidates_by_coverage(action_type, candidates, ctx)

            rejection_context = None
            # Every pick that passed validation this action type, not
            # just the first -- see the multi-pick loop below.
            accepted_batch = []

            for attempt in range(max_retries):
                if deadline is not None and _time.time() >= deadline:
                    break
                try:
                    llm_result = call_strategist_llm(candidates, zone, action_type, rejection_context, deadline=deadline)
                except Exception as e:
                    trace.append({"event": "llm_unreachable", "zone_index": zone_index, "action_type": action_type, "detail": str(e)[:200]})
                    logger.warning(
                        "strategist: LLM unreachable for zone %d action_type %s: %s: %s",
                        zone_index, action_type, type(e).__name__, e,
                    )
                    llm_error = e
                    break

                # The model may choose SEVERAL points for this action
                # type in one call. Validate each independently and keep
                # every one that passes -- one rejected pick no longer
                # throws away the whole answer.
                # Share the remaining slots across the action types this
                # zone has not tried yet. Without this the types at the
                # FRONT of the scenario's ACTION_ORDER take everything and
                # the ones at the back are never reached at all -- on real
                # river_overflow runs evacuation zones and warning points
                # filled the whole plan and not one road closure was ever
                # proposed, which is why the report's road row sat at 0%.
                # The order itself is unchanged; this only stops the front
                # of it starving the rest.
                remaining_slots = min(
                    MAX_ACTIONS_PER_ZONE - zone_accepted_count,
                    max_proposals - (len(proposals) + zone_accepted_count),
                )
                types_left = max(1, len(_remaining_action_types(cause_type, tried_action_types)) + 1)
                fair_share = -(-remaining_slots // types_left)  # ceil
                room = max(2, min(MAX_PICKS_PER_ACTION_TYPE, remaining_slots, fair_share))
                ids = picked_ids(llm_result, max(1, room))
                by_id = {c["id"]: c for c in candidates}
                last_reason = None

                for cid in ids:
                    candidate = by_id.get(cid)
                    if candidate is None:
                        last_reason = "invalid candidate_id -- pick ids from the list"
                        continue
                    parameters = _default_parameters(action_type, llm_result.get("parameters"))
                    result = validators_for(cause_type)[action_type](candidate["lat"], candidate["lon"], ctx)
                    if not result["accepted"]:
                        last_reason = result["reason"]
                        trace.append({"event": "rejected", "zone_index": zone_index,
                                      "action_type": action_type, "reason": result["reason"]})
                        continue
                    accepted_batch.append((candidate, parameters, result["payload"], llm_result))
                    trace.append({
                        "event": "accepted", "zone_index": zone_index, "action_type": action_type,
                        "location": {"lon": candidate["lon"], "lat": candidate["lat"]},
                    })

                if accepted_batch:
                    break
                rejection_context = last_reason or "no valid pick"

            for accepted_candidate, accepted_parameters, accepted_payload, accepted_llm_result in accepted_batch:
                if zone_accepted_count >= MAX_ACTIONS_PER_ZONE:
                    break
                if len(proposals) >= max_proposals:
                    break
                # Two different candidates can validate to the SAME
                # point (nearest_road / facility snapping collapses
                # them), which multi-pick made possible for the first
                # time. That is a duplicate action in the plan -- it
                # adds no coverage, and the UI keys proposals by
                # action_type+lat+lon, so a duplicate key made "Add to
                # plan" mark BOTH cards as added while creating only one
                # marker. Drop it here rather than papering over the key.
                _lon = accepted_payload.get("lon", accepted_candidate["lon"])
                _lat = accepted_payload.get("lat", accepted_candidate["lat"])
                if any(
                    p["action_type"] == action_type
                    and abs(p["location"]["lon"] - _lon) < 1e-6
                    and abs(p["location"]["lat"] - _lat) < 1e-6
                    for p in proposals
                ):
                    trace.append({
                        "event": "duplicate_skipped", "zone_index": zone_index,
                        "action_type": action_type,
                        "location": {"lon": _lon, "lat": _lat},
                    })
                    continue

                impact = compute_real_coverage_impact(action_type, accepted_candidate, accepted_parameters, ctx)
                zone_proposal = {
                    "action_type": action_type,
                    "location": {"lon": accepted_payload.get("lon", accepted_candidate["lon"]), "lat": accepted_payload.get("lat", accepted_candidate["lat"])},
                    "parameters": accepted_parameters,
                    "validated_payload": accepted_payload,
                    "real_coverage": impact,
                    "ai_reasoning": accepted_llm_result.get("reasoning"),
                    "zone_description": zone.get("description"),
                }

                # Commit this action immediately, then carry straight on
                # to the next action type for the SAME zone. Feeding it
                # into existing_actions / ctx first means the next
                # action's candidates are filtered against what this
                # plan has already placed, so the zone builds up a set
                # of complementary actions rather than stacking
                # near-duplicates on one spot.
                proposals.append(zone_proposal)
                zone_accepted_count += 1
                loc = zone_proposal["location"]
                existing_actions.append({"type": action_type, "lon": loc["lon"], "lat": loc["lat"]})
                # Register under every scenario's equivalent name, not
                # just river overflow's. Relief/medical posts require an
                # evacuation zone nearby, so a rainfall rainEvacZone
                # that never got registered meant rainMedicalPost could
                # never validate later in the same run.
                if action_type in ("evacuationZone", "rainEvacZone", "damEvacZone"):
                    ctx["existing_evac_zones"] = list(ctx.get("existing_evac_zones") or []) + [{"lon": loc["lon"], "lat": loc["lat"]}]
                if action_type in ("closeRoad", "rainRoadClosure", "damCrossingClosure"):
                    ctx["existing_closed_roads"] = list(ctx.get("existing_closed_roads") or []) + [{"lon": loc["lon"], "lat": loc["lat"]}]

        if zone_accepted_count > 0:
            trace.append({"event": "zone_done", "zone_index": zone_index, "actions_added": zone_accepted_count})
        else:
            trace.append({"event": "zone_skipped", "zone_index": zone_index})

    # ------------------------------------------------------------------
    # Deterministic fill for action types the plan never got to.
    #
    # Every LLM call is rate-limited (8/min) and shares one wall-clock
    # budget with the Hazard Reader, so a scenario with five action types
    # across two zones runs out of budget partway down the list. That is
    # why a real river_overflow plan came back with evacuation zones and
    # warning points and not one road closure -- and the second time,
    # with two road closures the model picked that both sat in 0.8m of
    # water, under the 1m impassable threshold, while 46 of the first 80
    # candidates in the flooded area validate cleanly.
    #
    # This runs ONCE, after the zone loop, with its own small budget --
    # not inside it. An earlier version put the fill in the loop, where a
    # single iteration's candidate generation could overshoot the grace
    # window and pushed one real request past five minutes.
    #
    # Nothing is relaxed: the same generator, the same real validator,
    # the same commit path. Recorded as "auto_topup" so a deterministic
    # fill is never presented as the model's own choice.
    # ------------------------------------------------------------------
    if uncovered_zones and len(proposals) < max_proposals:
        fill_deadline = _time.time() + FILL_GRACE_S
        placed_types = {p["action_type"] for p in proposals}
        missing = [a for a in action_order_for(cause_type) if a not in placed_types]
        zone = uncovered_zones[0]
        for action_type in missing:
            if _time.time() >= fill_deadline or len(proposals) >= max_proposals:
                break
            try:
                cands = RC.generate_candidates(action_type, zone["bbox"], ctx)
                cands = RC.filter_out_overlapping(cands, existing_actions)
            except Exception:
                continue
            if not cands:
                continue
            validator = validators_for(cause_type).get(action_type)
            if validator is None:
                continue
            added = 0
            # Unranked and capped: ranking costs up to
            # COVERAGE_SCAN_BUDGET_S per action type, which is most of
            # this whole pass's budget. These are still real, validated
            # placements -- just not coverage-optimised ones.
            for c in cands[:60]:
                if added >= FILL_MAX_PER_ACTION_TYPE or _time.time() >= fill_deadline:
                    break
                if len(proposals) >= max_proposals:
                    break
                try:
                    result = validator(c["lat"], c["lon"], ctx)
                except Exception:
                    continue
                if not result["accepted"]:
                    continue
                payload = result["payload"]
                lon = payload.get("lon", c["lon"])
                lat = payload.get("lat", c["lat"])
                if any(p["action_type"] == action_type
                       and abs(p["location"]["lon"] - lon) < 1e-6
                       and abs(p["location"]["lat"] - lat) < 1e-6
                       for p in proposals):
                    continue
                parameters = _default_parameters(action_type, None)
                proposals.append({
                    "action_type": action_type,
                    "location": {"lon": lon, "lat": lat},
                    "parameters": parameters,
                    "validated_payload": payload,
                    "real_coverage": compute_real_coverage_impact(action_type, c, parameters, ctx),
                    "ai_reasoning": ("Chosen from this action type's real validated candidates -- "
                                     "the AI call budget for this run was already spent before "
                                     "this action type came up."),
                    "zone_description": zone.get("description"),
                })
                existing_actions.append({"type": action_type, "lon": lon, "lat": lat})
                if action_type in ("closeRoad", "rainRoadClosure", "damCrossingClosure"):
                    ctx["existing_closed_roads"] = list(ctx.get("existing_closed_roads") or []) + [{"lon": lon, "lat": lat}]
                added += 1
                trace.append({"event": "auto_topup", "action_type": action_type,
                              "location": {"lon": lon, "lat": lat}})

    if not proposals and llm_error is not None:
        raise llm_error

    return {"proposals": proposals, "trace": trace}
