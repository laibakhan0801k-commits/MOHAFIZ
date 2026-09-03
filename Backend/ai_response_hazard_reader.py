"""
Response-side multi-agent AI comparison -- Part 1, Agent 1: Hazard Reader.

Reads the current simulation output and the user's existing Response Plan
(or lack of one) to identify which real areas of risk still need
attention.

Deliberately NOT a new from-scratch LLM prompt: the zone-identification
half of this job -- "given real simulation stats, where is the real risk
concentrated" -- is exactly what ai_hazard_analyst.run_hazard_analyst
already does (proven at 7/8 real success rate across live testing this
session), and hazard geography does not change between the prevention
and response use cases. So this module reuses it as-is for that half.

What's new here is the "or lack of one" half: whether a zone is already
served by something the user placed. That is real geometry (does an
evacuation zone/warning point's coverage radius already reach this zone,
is a road here already closed) -- exact distances a Python function can
check outright, not a judgment call worth spending an LLM call on. So
it's a deterministic filter, not a second agent, matching this project's
"the AI proposes, real code verifies" rule -- coverage-by-existing-plan
IS a verification, not a proposal.
"""
import ai_hazard_analyst as HA
from prevention_validation import distance_m
from response_validation import action_coverage_radius_m


def _zone_center(zone):
    w, s, e, n = zone["bbox"]
    return (s + n) / 2, (w + e) / 2  # (lat, lon)


def annotate_zone_coverage(zones, existing_response_actions):
    """For each hazard zone, checks real distance to every action already
    in the user's plan. A zone counts as covered if its center falls
    within that action's real reach. Returns the same zones with two new
    keys added: covered (bool) and covering_actions (list of the
    existing plan's action types that reach it) -- never removes a zone,
    so the caller decides whether to skip covered zones or still show
    them as "already addressed"."""
    existing_response_actions = existing_response_actions or []
    annotated = []
    for zone in zones:
        zlat, zlon = _zone_center(zone)
        covering = []
        for action in existing_response_actions:
            if action.get("lat") is None or action.get("lon") is None:
                continue
            reach = action_coverage_radius_m(action)
            if reach <= 0:
                continue
            d = distance_m(zlon, zlat, action["lon"], action["lat"])
            if d <= reach:
                covering.append(action.get("type"))
        z = dict(zone)
        z["covered"] = len(covering) > 0
        z["covering_actions"] = covering
        annotated.append(z)
    return annotated


def run_hazard_reader(simulation_stats, existing_response_actions=None, num_zones=3, deadline=None):
    """Agent 1. Returns {"priority_zones": [...], "uncovered_zones": [...]}
    -- priority_zones is exactly ai_hazard_analyst's real output (each
    zone: bbox, description, real facility/building counts inside it);
    uncovered_zones is the subset the user's existing plan does not
    already reach, annotated with covered/covering_actions for every
    zone either way so the caller can show "already served by your plan"
    instead of silently hiding it."""
    hazard = HA.run_hazard_analyst(simulation_stats, num_zones=num_zones, deadline=deadline)
    zones = annotate_zone_coverage(hazard["priority_zones"], existing_response_actions)
    uncovered = [z for z in zones if not z["covered"]]
    return {"priority_zones": zones, "uncovered_zones": uncovered}
