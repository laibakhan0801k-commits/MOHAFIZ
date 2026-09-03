"""
Response-side multi-agent AI comparison -- Part 3, Agent 3: Impact
Evaluator.

Real port of PlanWorkspace.js's computeRiverOverflowResponseCoverage --
the same function that already powers the (already-shipped) Response
Impact Report feature. Response actions never change the flood itself;
"before" and "after" both show the exact same flood/roads/buildings --
what differs is how much of that fixed risk is actually COVERED by
whichever set of actions is passed in. Calling this once with the
user's own plan and once with (user's plan + the Strategist's accepted
proposals) gives a genuine before/after comparison, reusing the exact
same coverage math the Response Impact Report already uses and this
session already tested -- not a new calculation path invented for the
AI feature.
"""
import road_flooding
from prevention_validation import distance_m
from response_validation import (
    depth_at_point, _feature_centroid, PEOPLE_PER_BUILDING_ESTIMATE,
    action_coverage_radius_m,
)


def river_overflow_at_risk_buildings(depth_grid, depth_meta, buildings_geojson):
    """Every real building whose centroid the depth grid currently marks
    as wet -- ports riverOverflowAtRiskBuildings."""
    out = []
    for feature in (buildings_geojson or {}).get("features", []):
        c = _feature_centroid(feature)
        if c is None:
            continue
        depth = depth_at_point(c[1], c[0], depth_grid, depth_meta)
        if depth is not None and depth > 0:
            out.append({"lon": c[0], "lat": c[1]})
    return out


def covered_by_any_marker(points, actions):
    """True count of `points` within reach of ANY action in `actions` --
    ports coveredByAnyMarker. Each action's real coverage reach comes
    from response_validation.action_coverage_radius_m -- the same real
    per-type radius (a placed marker's own user-set radius where one
    exists, the same real fixed service reach otherwise) every other
    caller in this feature already uses, so this can never silently
    diverge from the Hazard Reader's own coverage check."""
    if not points or not actions:
        return 0
    n = 0
    for pt in points:
        hit = False
        for a in actions:
            if a.get("lat") is None or a.get("lon") is None:
                continue
            r = action_coverage_radius_m(a)
            if r > 0 and distance_m(pt["lon"], pt["lat"], a["lon"], a["lat"]) <= r:
                hit = True
                break
        if hit:
            n += 1
    return n


def compute_river_overflow_response_coverage(water_level_m, ctx, actions):
    """
    actions: list of {"type", "lat", "lon", "params"|"parameters"} --
    either the user's real placed markers/closures, or that PLUS the
    Strategist's accepted proposals, or an empty list for a
    "no plan at all" baseline. Same function, same real geometry, only
    the action list changes -- so before/after can never silently drift
    onto different data (the same guarantee the frontend's own
    computeRiverOverflowResponseCoverage documents).

    Returns the scenario-agnostic coverage shape the Response Impact
    Report already renders: totals, per-category {covered, percent}.
    """
    at_risk = river_overflow_at_risk_buildings(ctx["depth_grid"], ctx["depth_meta"], ctx["buildings_geojson"])
    total_buildings = len(at_risk)
    total_people = round(total_buildings * PEOPLE_PER_BUILDING_ESTIMATE)

    road_result = road_flooding.get_flooded_roads(water_level_m)
    closed_set = {
        (a.get("road_u"), a.get("road_v"))
        for a in actions
        if a.get("type") == "closeRoad" and a.get("road_u") is not None and a.get("road_v") is not None
    }
    roads_total = road_result["flooded_edge_count"]
    roads_closed = sum(1 for e in road_result["flooded_edges"] if (e["u"], e["v"]) in closed_set)
    roads_open = roads_total - roads_closed

    evac_zones = [a for a in actions if a.get("type") == "evacuationZone"]
    boat_launches = [a for a in actions if a.get("type") == "boatLaunch"]
    relief_posts = [a for a in actions if a.get("type") == "reliefMedicalPost"]
    warning_points = [a for a in actions if a.get("type") == "warningPoint"]

    evac_covered = covered_by_any_marker(at_risk, evac_zones)
    rescue_covered = covered_by_any_marker(at_risk, boat_launches)
    relief_covered = covered_by_any_marker(at_risk, relief_posts)
    warning_covered = covered_by_any_marker(at_risk, warning_points)

    def pct(n):
        return round((n / total_buildings) * 100) if total_buildings > 0 else 0

    return {
        "total_buildings": total_buildings,
        "total_people": total_people,
        "roads": {"total": roads_total, "open": roads_open, "closed": roads_closed},
        "evacuation": {"covered": evac_covered, "percent": pct(evac_covered)},
        "rescue": {"covered": rescue_covered, "percent": pct(rescue_covered)},
        "relief": {"covered": relief_covered, "percent": pct(relief_covered)},
        "warning": {"covered": warning_covered, "percent": pct(warning_covered), "people": round(warning_covered * PEOPLE_PER_BUILDING_ESTIMATE)},
    }


def proposal_to_action(proposal):
    """Converts one accepted Strategist proposal (ai_response_strategist.py's
    output shape) into the {"type","lat","lon","parameters","road_u","road_v"}
    shape compute_river_overflow_response_coverage reads -- road_u/road_v
    come from the real validated_payload (response_validation's own
    nearest_road match), not re-derived."""
    action = {
        "type": proposal["action_type"],
        "lat": proposal["location"]["lat"],
        "lon": proposal["location"]["lon"],
        "parameters": proposal.get("parameters") or {},
    }
    payload = proposal.get("validated_payload") or {}
    if proposal["action_type"] == "closeRoad":
        action["road_u"] = payload.get("road_u")
        action["road_v"] = payload.get("road_v")
    return action


def run_response_evaluator(water_level_m, ctx, existing_actions, proposed_actions):
    """
    Agent 3. Computes the real coverage BEFORE (the user's own plan
    only) and AFTER (the user's plan plus the Strategist's accepted
    proposals), from the exact same function -- never two different
    calculations that could drift apart. Returns
    {"before": {...}, "after": {...}}, both in the coverage shape above.
    """
    before = compute_river_overflow_response_coverage(water_level_m, ctx, existing_actions or [])
    after = compute_river_overflow_response_coverage(water_level_m, ctx, (existing_actions or []) + (proposed_actions or []))
    return {"before": before, "after": after}
