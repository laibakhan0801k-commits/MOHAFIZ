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
        # percent so the report can state this the same way every
        # other coverage row is stated -- a before/after that moves.
        # "closed" means a closure was PLACED on that segment, not
        # that the flood cleared; the old raw "N open, 0 closed"
        # pair read like a flood measurement and never changed.
        "roads": {"total": roads_total, "open": roads_open, "closed": roads_closed,
                  "percent": round(100 * roads_closed / roads_total) if roads_total else 0},
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
    # Every closure type, not just river overflow's. This used to test
    # `action_type == "closeRoad"`, so a rainfall rainRoadClosure and a
    # dam damCrossingClosure reached the evaluator with no road_u/road_v
    # at all -- and since the evaluator matches closures to real road
    # segments BY u/v, they matched nothing. A real rainfall run placed
    # ten valid road closures and the impact report still reported
    # "0 of 402 low points barricaded".
    if payload.get("road_u") is not None or payload.get("road_v") is not None:
        action["road_u"] = payload.get("road_u")
        action["road_v"] = payload.get("road_v")
    return action


def compute_rainfall_response_coverage(ctx, actions):
    """Rainfall's coverage, in the SAME output shape as the river
    overflow version above so the Impact Report renders identically.

    The only real difference is what "at risk" means: rainfall has no
    modelled flood extent, so the at-risk set is every building inside a
    mapped drainage-risk zone, and road closures count against the real
    mapped underpass/road-sag low points rather than flooded edges.
    """
    import response_validation_rainfall as RVR

    at_risk = RVR.at_risk_buildings(ctx["buildings_geojson"])
    total_buildings = len(at_risk)
    total_people = round(total_buildings * PEOPLE_PER_BUILDING_ESTIMATE)

    low_points = RVR.load_road_low_points().get("features", [])
    roads_total = len(low_points)
    closed_uv = {
        (a.get("road_u"), a.get("road_v"))
        for a in actions
        if a.get("type") == "rainRoadClosure" and a.get("road_u") is not None
    }
    roads_closed = sum(
        1 for f in low_points
        if ((f.get("properties") or {}).get("u"), (f.get("properties") or {}).get("v")) in closed_uv
    )
    roads_open = roads_total - roads_closed

    def by_type(t):
        return [a for a in actions if a.get("type") == t]

    evac_covered = covered_by_any_marker(at_risk, by_type("rainEvacZone"))
    rescue_covered = covered_by_any_marker(at_risk, by_type("rainWaterRescue"))
    relief_covered = covered_by_any_marker(
        at_risk, by_type("rainMedicalPost") + by_type("rainReliefCamp")
    )
    warning_covered = covered_by_any_marker(at_risk, by_type("rainWarning"))

    def pct(n):
        return round((n / total_buildings) * 100) if total_buildings > 0 else 0

    return {
        "total_buildings": total_buildings,
        "total_people": total_people,
        # percent so the report can state this the same way every
        # other coverage row is stated -- a before/after that moves.
        # "closed" means a closure was PLACED on that segment, not
        # that the flood cleared; the old raw "N open, 0 closed"
        # pair read like a flood measurement and never changed.
        "roads": {"total": roads_total, "open": roads_open, "closed": roads_closed,
                  "percent": round(100 * roads_closed / roads_total) if roads_total else 0},
        "evacuation": {"covered": evac_covered, "percent": pct(evac_covered)},
        "rescue": {"covered": rescue_covered, "percent": pct(rescue_covered)},
        "relief": {"covered": relief_covered, "percent": pct(relief_covered)},
        "warning": {"covered": warning_covered, "percent": pct(warning_covered), "people": round(warning_covered * PEOPLE_PER_BUILDING_ESTIMATE)},
    }


def run_response_evaluator(water_level_m, ctx, existing_actions, proposed_actions):
    """
    Agent 3. Computes the real coverage BEFORE (the user's own plan
    only) and AFTER (the user's plan plus the Strategist's accepted
    proposals), from the exact same function -- never two different
    calculations that could drift apart. Returns
    {"before": {...}, "after": {...}}, both in the coverage shape above.

    Dispatches on the scenario, since rainfall measures a different
    at-risk set (drainage-risk zones, not a modelled flood extent) --
    but returns the identical shape either way.
    """
    existing_actions = existing_actions or []
    proposed_actions = proposed_actions or []

    if ctx.get("cause_type") == "dam_release":
        import response_validation_dam as RVDAM
        return {"before": RVDAM.compute_coverage(ctx, existing_actions),
                "after": RVDAM.compute_coverage(ctx, existing_actions + proposed_actions)}

    if ctx.get("cause_type") == "drainage_failure":
        import response_validation_drainage as RVD
        return {"before": RVD.compute_coverage(ctx, existing_actions),
                "after": RVD.compute_coverage(ctx, existing_actions + proposed_actions)}

    if ctx.get("cause_type") == "rainfall":
        before = compute_rainfall_response_coverage(ctx, existing_actions)
        after = compute_rainfall_response_coverage(ctx, existing_actions + proposed_actions)
        return {"before": before, "after": after}

    before = compute_river_overflow_response_coverage(water_level_m, ctx, existing_actions)
    after = compute_river_overflow_response_coverage(water_level_m, ctx, existing_actions + proposed_actions)
    return {"before": before, "after": after}

# What each coverage row MEANS, per scenario. The five row keys are
# shared so one report component renders every scenario, but they do not
# all measure the same thing: "roads" is flood-cut road segments for a
# river overflow, low-point/underpass segments for rainfall, wet
# junctions for a drainage failure and channel crossings for a dam
# release. The panel used to hard-code one wording for all four, which
# labelled dam crossings as flooded roads. response_validation_dam and
# response_validation_drainage already each carried a ROW_LABELS dict
# for exactly this -- neither was ever read by anything. These are those,
# gathered where the comparison is actually built.
ROW_LABELS_BY_CAUSE = {
    "river_overflow": {
        "evacuation": "Evacuation coverage",
        "roads": "Flood-cut roads barricaded",
        "rescue": "Rescue-staging coverage",
        "relief": "Relief/medical coverage",
        "warning": "Warning coverage",
    },
    "rainfall": {
        "evacuation": "Evacuation coverage",
        "roads": "Flooded low points barricaded",
        "rescue": "Water-rescue coverage",
        "relief": "Relief/medical coverage",
        "warning": "Warning coverage",
    },
    "drainage_failure": {
        "evacuation": "Drainage-risk area treated",
        "roads": "Wet junctions flagged",
        "rescue": "Buildings near an intervention",
        "relief": "Buildings near vector control",
        "warning": "Overflow points flagged",
    },
    "dam_release": {
        "evacuation": "Buildings inside a time-tiered evacuation zone",
        "roads": "Dangerous crossings closed",
        "rescue": "Buildings within walking reach of a rally point",
        # No relief/medical action exists for a dam release (see
        # response_validation_dam.ACTION_ORDER), so compute_coverage
        # hard-codes that row's percent to 0 -- it can never move.
        # null = do not render the row at all, rather than show a
        # permanent 0% that reads as a failing plan.
        "relief": None,
        "warning": "Buildings within dam-release warning range",
    },
}


def row_labels_for(cause_type):
    return ROW_LABELS_BY_CAUSE.get(cause_type) or ROW_LABELS_BY_CAUSE["river_overflow"]
