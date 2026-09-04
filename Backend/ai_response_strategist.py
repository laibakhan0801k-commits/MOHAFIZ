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
import logging

logger = logging.getLogger(__name__)

# Fixed try-order for river_overflow -- evacuationZone first because
# reliefMedicalPost's real validation REQUIRES an existing evacuation
# zone nearby (response_validation.validate_relief_medical_post), so a
# zone can't produce a usable relief post before an evac zone exists
# somewhere near it (either already in the user's plan, or proposed
# earlier this same run -- see run_response_strategist below).
RIVER_OVERFLOW_ACTION_ORDER = ["evacuationZone", "warningPoint", "closeRoad", "boatLaunch", "reliefMedicalPost"]


def decide_action_type_for_zone(already_tried=None):
    already_tried = already_tried or set()
    for action_type in RIVER_OVERFLOW_ACTION_ORDER:
        if action_type not in already_tried:
            return action_type
    return None


def build_strategist_prompt(candidates, zone, action_type, rejection_context):
    import json
    candidates_json = json.dumps([{"id": c["id"], "descriptor": c["descriptor"]} for c in candidates])
    retry_note = ""
    if rejection_context:
        retry_note = (
            f"\nYour previous proposal was rejected: \"{rejection_context}\". "
            "Pick a DIFFERENT candidate id that avoids that problem."
        )

    return f"""You are proposing ONE real "{action_type}" emergency response action
from a fixed list of real candidate points, for this priority hazard zone:
"{zone.get('description', 'priority zone')}"

Pick the candidate id that best addresses this zone.{retry_note}

Candidates:
{candidates_json}

Return ONLY this JSON shape:
{{"candidate_id": 0, "parameters": {{}}, "reasoning": "short real reasoning"}}"""


def _validate_strategist_shape(parsed):
    if not isinstance(parsed, dict) or "candidate_id" not in parsed:
        raise ValueError("strategist response missing 'candidate_id'")


def call_strategist_llm(candidates, zone, action_type, rejection_context=None, deadline=None):
    prompt = build_strategist_prompt(candidates, zone, action_type, rejection_context)
    return ai_llm.call_llm_json(prompt, validate_fn=_validate_strategist_shape, max_retries=3, deadline=deadline)


def _default_parameters(action_type, llm_parameters):
    params = dict(llm_parameters or {})
    if action_type == "warningPoint":
        params.setdefault("coverage_radius_m", DEFAULT_WARNING_RADIUS_M)
    elif action_type == "evacuationZone":
        params.setdefault("radius_m", DEFAULT_EVAC_RADIUS_M)
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


def run_response_strategist(uncovered_zones, cause_type, ctx, max_proposals=4, max_retries=3, deadline=None):
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
    if cause_type != "river_overflow":
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

        while zone_proposal is None:
            if deadline is not None and _time.time() >= deadline:
                break
            action_type = decide_action_type_for_zone(tried_action_types)
            if action_type is None:
                break
            tried_action_types.add(action_type)
            trace.append({"event": "action_type_start", "zone_index": zone_index, "action_type": action_type})

            candidates = RC.generate_candidates(action_type, zone["bbox"], ctx)
            candidates = RC.filter_out_overlapping(candidates, existing_actions)
            if not candidates:
                trace.append({"event": "no_candidates", "zone_index": zone_index, "action_type": action_type})
                continue

            rejection_context = None
            accepted_candidate = None
            accepted_parameters = None
            accepted_payload = None
            accepted_llm_result = None

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

                candidate = next((c for c in candidates if c["id"] == llm_result.get("candidate_id")), None)
                if candidate is None:
                    rejection_context = "invalid candidate_id -- pick one from the list"
                    trace.append({"event": "rejected", "zone_index": zone_index, "action_type": action_type, "reason": rejection_context})
                    continue

                parameters = _default_parameters(action_type, llm_result.get("parameters"))
                result = RV.VALIDATORS[action_type](candidate["lat"], candidate["lon"], ctx)
                if result["accepted"]:
                    accepted_candidate = candidate
                    accepted_parameters = parameters
                    accepted_payload = result["payload"]
                    accepted_llm_result = llm_result
                    trace.append({
                        "event": "accepted", "zone_index": zone_index, "action_type": action_type,
                        "location": {"lon": candidate["lon"], "lat": candidate["lat"]},
                    })
                    break
                rejection_context = result["reason"]
                trace.append({"event": "rejected", "zone_index": zone_index, "action_type": action_type, "reason": result["reason"]})

            if accepted_candidate is not None:
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

        if zone_proposal is not None:
            proposals.append(zone_proposal)
            trace.append({"event": "zone_done", "zone_index": zone_index})
            loc = zone_proposal["location"]
            existing_actions.append({"type": zone_proposal["action_type"], "lon": loc["lon"], "lat": loc["lat"]})
            if zone_proposal["action_type"] == "evacuationZone":
                ctx["existing_evac_zones"] = list(ctx.get("existing_evac_zones") or []) + [{"lon": loc["lon"], "lat": loc["lat"]}]
            if zone_proposal["action_type"] == "closeRoad":
                ctx["existing_closed_roads"] = list(ctx.get("existing_closed_roads") or []) + [{"lon": loc["lon"], "lat": loc["lat"]}]
        else:
            trace.append({"event": "zone_skipped", "zone_index": zone_index})

    if not proposals and llm_error is not None:
        raise llm_error

    return {"proposals": proposals, "trace": trace}
