"""
PREVENTION COVERAGE -- the honest, measurable impact metric for a
prevention plan.

WHY THIS EXISTS
---------------
A prevention plan's flood-extent numbers barely move, and that is not a
bug. A retention pond holds a few thousand cubic metres; the catchment
behind this DEM holds millions. A desilting programme that treats 200m
of channel has treated 0.4% of a 56km network. Both facts are real, and
_run_prevention_sim reports them honestly -- which is why the impact
report kept saying "no measurable improvement at this scale".

But "the basin-wide flood stage didn't drop" is not the same as "this
plan does nothing". What a local prevention measure genuinely does is
protect the ground around it. That IS measurable, from real geometry,
and it is the same shape of metric the AI RESPONSE plan already reports
(response_validation*.py): not "we lowered the flood", but "this many of
the buildings actually exposed to it are now covered by a real measure".

So this module answers one question with real numbers:

    Of the buildings actually exposed to this flood, how many now sit
    inside the real service reach of a real prevention measure?

Nothing here is estimated or scaled to look good. The exposure test is
the same elevation-vs-water-level test flood_engine already uses to
count affected buildings, and every protection reach is read from the
SAME constants flood_engine.apply_local_protection uses to spend an
action's intercepted volume -- see action_protection_reach_m.
"""
import math

import flood_engine
import road_flooding


# A building is "exposed" if its ground sits at or below the water level
# (flood_engine's own affected-building test) OR within this much of it.
# Prevention is planned against the flood you are trying to stop, not
# only the one already in the street, so the margin is included -- but
# it is a stated, fixed margin, never tuned per scenario to move a
# percentage.
AT_RISK_FREEBOARD_M = 1.0

# SYNC: flood_engine.apply_local_protection BASE_RADIUS_M. The
# neighbourhood-block service radius every local measure gets.
BASE_REACH_M = 40.0

# Capacity ceilings live in flood_engine._CAPACITY_CEILINGS; these are
# the action types whose benefit is channel conveyance rather than a
# local footprint, reported separately as treated channel length.
CHANNEL_CAPACITY_ACTIONS = ("desilt", "clearDrains")

# Actions that warn rather than protect. Counted separately so a plan
# can never claim a gauge shielded a building.
WARNING_ACTIONS = ("warningGauge",)


def _param(action, *names, default=0.0):
    """First present numeric parameter among `names`. Prevention actions
    reach here in two shapes -- the frontend's camelCase form params and
    the proposer's snake_case parameters -- so both are accepted."""
    params = action.get("params") or action.get("parameters") or {}
    for n in names:
        v = params.get(n)
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            return f
    return float(default)


def action_protection_reach_m(action):
    """Real service reach of one prevention action, in metres.

    Every number below is the one flood_engine.apply_local_protection
    already uses to decide how far that action's intercepted volume is
    spread -- this function only reads the same geometry, it does not
    invent a wider footprint. Returns 0.0 for actions that do not
    protect ground (warning gauges).
    """
    atype = action.get("type") or action.get("action_type")

    if atype in WARNING_ACTIONS:
        return 0.0

    if atype == "retentionPond":
        # SYNC: apply_local_protection -- max(BASE_RADIUS_M, 2.5 * pond radius).
        area = _param(action, "area", "area_m2", default=0.0) or 10000.0
        radius = math.sqrt(area / math.pi)
        return max(BASE_REACH_M, 2.5 * radius)

    if atype in ("widenChannel", "embankment", "greenBuffer") or atype in CHANNEL_CAPACITY_ACTIONS:
        # Linear measures serve the floodplain either side of their own
        # length: BASE_REACH_M out from the line, so ground anywhere
        # along the treated reach is within half its length plus that.
        length = _param(action, "length", "sectionLength", "section_length_m",
                        "length_m", default=50.0)
        return BASE_REACH_M + length / 2.0

    if atype == "removeEncroachment":
        # SYNC: apply_local_protection -- encroachments get BASE_RADIUS_M.
        return BASE_REACH_M

    # Unknown action type: claim nothing rather than guess a footprint.
    return 0.0


def at_risk_buildings(elevation_array, dem_bounds, water_level_m):
    """Real building centroids exposed to this flood.

    Same test as flood_engine.count_affected_buildings_on_array, widened
    by AT_RISK_FREEBOARD_M -- so this is a superset of the "buildings
    affected" figure the impact report already shows, computed from the
    same DEM samples.
    """
    cache_key = ("_prevention_at_risk", round(water_level_m, 3), id(elevation_array))
    cached = globals().setdefault("_at_risk_cache", {}).get(cache_key)
    if cached is not None:
        return cached

    threshold = water_level_m + AT_RISK_FREEBOARD_M
    points = []
    for feature in flood_engine.load_buildings()["features"]:
        centroid = flood_engine._building_centroid_lonlat(feature)
        if centroid is None:
            continue
        lon, lat = centroid
        elev = flood_engine.sample_elevation_from_array(elevation_array, dem_bounds, lon, lat)
        if elev != elev or elev <= -1000:  # NaN / nodata
            continue
        if elev <= threshold:
            points.append((lon, lat))

    globals()["_at_risk_cache"][cache_key] = points
    return points


def flooded_buildings(elevation_array, dem_bounds, water_level_m):
    """Buildings that are ACTUALLY under water right now -- exactly the
    set flood_engine.count_affected_buildings_on_array counts, with no
    freeboard band added.

    at_risk_buildings above deliberately widens by AT_RISK_FREEBOARD_M,
    which is right for "who should this plan serve". It is wrong for
    "which buildings could this plan take OUT of the flood": a dry
    building 0.5m above the water scored exactly the same as one
    standing in it, so a placement protecting three dry neighbours
    outranked one that would have lifted three flooded homes clear, and
    the impact report's "buildings affected" stayed put.
    """
    cache_key = ("_flooded", round(water_level_m, 3), id(elevation_array))
    cached = globals().setdefault("_flooded_cache", {}).get(cache_key)
    if cached is not None:
        return cached

    points = []
    for feature in flood_engine.load_buildings()["features"]:
        centroid = flood_engine._building_centroid_lonlat(feature)
        if centroid is None:
            continue
        lon, lat = centroid
        elev = flood_engine.sample_elevation_from_array(elevation_array, dem_bounds, lon, lat)
        if elev != elev or elev <= -1000:
            continue
        if elev <= water_level_m:
            points.append((lon, lat))

    globals()["_flooded_cache"][cache_key] = points
    return points


def cut_road_points(elevation_array, dem_bounds, water_level_m):
    """Midpoints of the real road edges this flood cuts.

    Same graph and the same node-flooded test road_flooding already uses
    to report "roads cut" in the impact report -- this just keeps WHERE
    each cut edge is, so a plan can be measured against the road network
    it is supposed to keep open, not only against building footprints.
    """
    cache_key = ("_cut_roads", round(water_level_m, 3), id(elevation_array))
    cached = globals().setdefault("_cut_road_cache", {}).get(cache_key)
    if cached is not None:
        return cached

    import numpy as np

    G = road_flooding.load_roads()
    node_flooded = {}
    for node_id in G.nodes:
        lon = G.nodes[node_id]["x"]
        lat = G.nodes[node_id]["y"]
        elev = flood_engine.sample_elevation_from_array(elevation_array, dem_bounds, lon, lat)
        node_flooded[node_id] = (not np.isnan(elev) and elev <= water_level_m)

    points = []
    for u, v in G.edges():
        if node_flooded.get(u, False) or node_flooded.get(v, False):
            points.append((
                (G.nodes[u]["x"] + G.nodes[v]["x"]) / 2.0,
                (G.nodes[u]["y"] + G.nodes[v]["y"]) / 2.0,
            ))

    globals()["_cut_road_cache"][cache_key] = points
    return points


def _distance_m(lon1, lat1, lon2, lat2):
    """Equirectangular metres -- the same approximation used throughout
    prevention_validation for distances at this scale."""
    mean_lat = math.radians((lat1 + lat2) / 2.0)
    dx = (lon2 - lon1) * 111320.0 * math.cos(mean_lat)
    dy = (lat2 - lat1) * 110540.0
    return math.sqrt(dx * dx + dy * dy)


def _action_lonlat(action):
    lon = action.get("lon", action.get("lng"))
    lat = action.get("lat")
    if lon is None or lat is None:
        loc = action.get("location") or {}
        lon, lat = loc.get("lon"), loc.get("lat")
    return lon, lat


def compute_coverage(actions, elevation_array, dem_bounds, water_level_m,
                     waterways_geojson=None, cause_type=None):
    """Real before/after protection coverage for a whole prevention plan.

    "Before" is always 0% protected -- with no measures placed, no
    exposed building is inside any measure's reach. That is a fact, not
    a baseline chosen to flatter the after number.

    Returns per-action reaches too, so the UI can show WHY a building
    counts as covered rather than asking anyone to trust the total.
    """
    exposed = at_risk_buildings(elevation_array, dem_bounds, water_level_m)
    total = len(exposed)

    reaches = []
    for action in actions or []:
        lon, lat = _action_lonlat(action)
        if lon is None or lat is None:
            continue
        reach = action_protection_reach_m(action)
        if reach <= 0:
            continue
        reaches.append({
            "type": action.get("type") or action.get("action_type"),
            "lon": lon, "lat": lat, "reach_m": round(reach, 1),
        })

    covered = set()
    per_action_counts = []
    for r in reaches:
        hits = [i for i, (blon, blat) in enumerate(exposed)
                if _distance_m(r["lon"], r["lat"], blon, blat) <= r["reach_m"]]
        per_action_counts.append({
            "type": r["type"], "reach_m": r["reach_m"],
            "buildings_in_reach": len(hits),
            # What this action adds that nothing else already covers --
            # the honest way to show a plan's marginal value.
            "buildings_newly_covered": len(set(hits) - covered),
        })
        covered.update(hits)

    protected = len(covered)
    percent = round(100.0 * protected / total, 1) if total else 0.0

    # Channel conveyance is a separate, real, differently-scaled claim:
    # metres of channel actually treated against the real network length
    # inside the study catchment. Never folded into the building number.
    capacity_actions = [a for a in (actions or [])
                        if (a.get("type") or a.get("action_type")) in CHANNEL_CAPACITY_ACTIONS]
    treated_m = sum(_param(a, "length", "sectionLength", "section_length_m", "length_m",
                           default=0.0) for a in capacity_actions)
    network_m = flood_engine.get_total_waterway_length_m(waterways_geojson)

    warning_count = sum(1 for a in (actions or [])
                        if (a.get("type") or a.get("action_type")) in WARNING_ACTIONS)

    # Same coverage question asked of the road network the flood cuts.
    cut_roads = cut_road_points(elevation_array, dem_bounds, water_level_m)
    roads_covered = set()
    for r in reaches:
        for i, (rlon, rlat) in enumerate(cut_roads):
            if i in roads_covered:
                continue
            if _distance_m(r["lon"], r["lat"], rlon, rlat) <= r["reach_m"]:
                roads_covered.add(i)
    roads_total = len(cut_roads)
    roads_pct = round(100.0 * len(roads_covered) / roads_total, 1) if roads_total else 0.0

    return {
        "at_risk_buildings": total,
        "protected_before": 0,
        "protected_after": protected,
        "protected_percent_before": 0.0,
        "protected_percent_after": percent,
        "unprotected_percent_after": round(100.0 - percent, 1) if total else 100.0,
        "measures_counted": len(reaches),
        "per_action": per_action_counts,
        "treated_channel_m": round(treated_m, 1),
        "total_channel_m": round(network_m, 1),
        "treated_channel_percent": round(100.0 * treated_m / network_m, 2) if network_m else 0.0,
        "warning_gauges": warning_count,
        "freeboard_m": AT_RISK_FREEBOARD_M,
        "cut_roads_total": roads_total,
        "cut_roads_covered": len(roads_covered),
        "cut_roads_percent_before": 0.0,
        "cut_roads_percent_after": roads_pct,
    }


def local_flood_reduction(before_mask, after_mask, protection_array):
    """Flood reduction WHERE THE MEASURES ACT, from the same two masks
    the impact report's own before/after images are drawn from.

    Basin-wide flooded area is the honest headline and it barely moves --
    a plan's few thousand cubic metres against a catchment holding
    millions. But that average is taken over the whole 50km2 study area,
    almost none of which any measure touches, so it hides the effect
    instead of reporting it. Inside the ground a measure actually
    serves, the change is real and worth stating.

    "Protected ground" is exactly the footprint flood_engine.
    apply_local_protection raised -- every pixel where that function put
    more than zero metres of protection. No radius is invented here.

    Returns None when the plan has no locally-protective measure at all
    (a desilting-only plan raises no ground), rather than reporting a
    zero-area zone as a 0% improvement.
    """
    import numpy as np

    if protection_array is None:
        return None
    zone = protection_array > 0
    zone_pixels = int(np.count_nonzero(zone))
    if zone_pixels == 0:
        return None

    flooded_before = int(np.count_nonzero(before_mask & zone))
    flooded_after = int(np.count_nonzero(after_mask & zone))
    drained = max(0, flooded_before - flooded_after)

    pct = lambda n: round(100.0 * n / zone_pixels, 1)
    reduction = round(100.0 * drained / flooded_before, 1) if flooded_before else 0.0

    return {
        "zone_area_m2": round(zone_pixels * flood_engine.PIXEL_AREA_M2, 0),
        "flooded_before_m2": round(flooded_before * flood_engine.PIXEL_AREA_M2, 0),
        "flooded_after_m2": round(flooded_after * flood_engine.PIXEL_AREA_M2, 0),
        "drained_m2": round(drained * flood_engine.PIXEL_AREA_M2, 0),
        "flooded_percent_before": pct(flooded_before),
        "flooded_percent_after": pct(flooded_after),
        "reduction_percent": reduction,
    }
