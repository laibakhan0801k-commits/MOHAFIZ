"""
Response Plan validation -- DAM RELEASE.

A real port of PlanWorkspace.js's dam-release response resolvers
(resolveDamReleaseTracking / resolveDamWarningPoint / resolveDamEvacZone /
resolveDamCrossingClosure / resolveDamRallyPoint) and
RESPONSE_RULES.dam_release, so the AI Strategist validates against
EXACTLY the rules a human click already faces.

Dam release is the one scenario built around TIME rather than depth:
Rawal Dam releases into the Korang, and every action is organised by how
long the release wave takes to reach a point. The constants below are
copied verbatim from the frontend, including its own caveats -- the dam
coordinate is a public general-reference point, the wave speed is a
planning assumption rather than a Korang-specific measurement, and the
distance is straight-line, not channel-following. Those limits are
inherited here rather than quietly "improved", so the backend and the
map can never disagree about what a countdown means.
"""
import math

import response_validation as RV
import prevention_validation as PV
from shapely.geometry import Point

RULES = {
    "RAWAL_DAM_LAT": 33.69335,
    "RAWAL_DAM_LON": 73.12413,
    "FLOOD_WAVE_SPEED_KMH": 12,
    "REFERENCE_DISCHARGE_CUSECS": 6283,
    "DISCHARGE_SPEED_MIN_FACTOR": 0.7,
    "DISCHARGE_SPEED_MAX_FACTOR": 1.5,
    "ARRIVAL_TIER_IMMEDIATE_MIN": 30,
    "ARRIVAL_TIER_SOON_MIN": 120,
    "WARNING_SNAP_MAX_M": 80,
    "CROSSING_SNAP_MAX_M": 30,
    "WALK_SPEED_KMH": 5,
    "RALLY_REACTION_FRACTION": 0.5,
    "RALLY_SAFE_CLEARANCE_M": 25,
    "SAME_TYPE_OVERLAP_M": 30,
}

# Reach used for coverage. Warning and evacuation carry the same real
# radii as the other scenarios; a rally point serves people who can walk
# to it, so its reach is the distance coverable at WALK_SPEED_KMH within
# the reaction fraction of a typical 30-minute first tier.
DEFAULT_WARNING_RADIUS_M = 400
DEFAULT_EVAC_RADIUS_M = 300
RALLY_REACH_M = 1250
CROSSING_REACH_M = 200


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def current_discharge_cusecs(ctx):
    v = ctx.get("dam_discharge_cusecs")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return RULES["REFERENCE_DISCHARGE_CUSECS"]
    return v if v > 0 else RULES["REFERENCE_DISCHARGE_CUSECS"]


def dam_arrival(lat, lon, discharge_cusecs):
    """Straight-line distance from Rawal Dam and the estimated minutes
    for the release wave to reach that point -- the countdown every
    dam-release action is built around. Ports damArrival exactly."""
    distance_km = haversine_km(RULES["RAWAL_DAM_LAT"], RULES["RAWAL_DAM_LON"], lat, lon)
    factor = min(
        RULES["DISCHARGE_SPEED_MAX_FACTOR"],
        max(RULES["DISCHARGE_SPEED_MIN_FACTOR"], discharge_cusecs / RULES["REFERENCE_DISCHARGE_CUSECS"]),
    )
    speed = RULES["FLOOD_WAVE_SPEED_KMH"] * factor
    return {"distance_km": distance_km, "minutes": (distance_km / speed) * 60, "speed_kmh": speed}


def arrival_tier(minutes):
    if minutes < RULES["ARRIVAL_TIER_IMMEDIATE_MIN"]:
        return "immediate"
    if minutes < RULES["ARRIVAL_TIER_SOON_MIN"]:
        return "soon"
    return "later"


def _within_modeled_area(lat, lon):
    import flood_engine
    w, s, e, n = flood_engine.get_dem_bounds()
    return w <= lon <= e and s <= lat <= n


def _waterways(ctx):
    ww = ctx.get("waterways_geojson")
    if not ww:
        import flood_engine
        ww = flood_engine.load_waterways()
        ctx["waterways_geojson"] = ww
    return ww


_crossings_cache = None


def crossing_points(ctx):
    """Every real place a road crosses the nullah network.

    This is the honest denominator for "crossings closed". The previous
    version used the number of closures the plan itself had placed as
    the total, so the row could only ever read 0 of 0 or 100% -- it
    counted the answer instead of the question. A dam crossing closure
    is only valid ON a channel crossing (validate_dam_crossing_closure),
    so the set of those crossings is what a plan is being measured
    against.

    Real geometry only: road LineStrings intersected with waterway
    LineStrings, restricted to the modelled area. Cached because the
    two layers never change within a run.
    """
    global _crossings_cache
    if _crossings_cache is not None:
        return _crossings_cache

    from shapely.geometry import shape as _shape

    roads = (ctx.get("roads_geojson") or {}).get("features") or []
    ways = _waterways(ctx).get("features") or []
    if not roads or not ways:
        _crossings_cache = []
        return _crossings_cache

    way_geoms = []
    for f in ways:
        g = f.get("geometry")
        if g and g.get("type") in ("LineString", "MultiLineString"):
            try:
                way_geoms.append(_shape(g))
            except Exception:
                continue

    # Spatial index over the channels. Testing all ~11,500 roads against
    # all ~215 waterways pairwise took 43s -- far too long to sit inside
    # a request's time budget. The index turns that into a bbox lookup
    # per road, and the answer is identical.
    from shapely.strtree import STRtree

    tree = STRtree(way_geoms)
    points = []
    for f in roads:
        g = f.get("geometry")
        if not g or g.get("type") not in ("LineString", "MultiLineString"):
            continue
        try:
            rg = _shape(g)
        except Exception:
            continue
        for idx in tree.query(rg):
            wg = way_geoms[idx]
            if not rg.intersects(wg):
                continue
            inter = rg.intersection(wg)
            for geom in getattr(inter, "geoms", [inter]):
                if geom.is_empty:
                    continue
                pt = geom if geom.geom_type == "Point" else geom.centroid
                if _within_modeled_area(pt.y, pt.x):
                    points.append({"lon": pt.x, "lat": pt.y})

    # De-duplicate: several road features can meet the channel at what is
    # physically one bridge.
    deduped = []
    for p in points:
        if not any(RV.distance_m(p["lon"], p["lat"], q["lon"], q["lat"]) < 25 for q in deduped):
            deduped.append(p)

    _crossings_cache = deduped
    return _crossings_cache


def _waterway_distance_m(lat, lon, ctx):
    return PV.nearest_line_distance_m(Point(lon, lat), _waterways(ctx))


def _depth_at(lat, lon, ctx):
    d = RV.depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    return d if d is not None else 0.0


def _arrival_payload(lat, lon, ctx):
    a = dam_arrival(lat, lon, current_discharge_cusecs(ctx))
    return {
        "distance_from_dam_km": round(a["distance_km"], 2),
        "arrival_minutes": round(a["minutes"]),
        "tier": arrival_tier(a["minutes"]),
    }


def validate_dam_release_tracking(lat, lon, ctx):
    """A tracking point just has to be inside the modeled area -- it
    records the release rate the rest of the countdown is scaled from."""
    if not _within_modeled_area(lat, lon):
        return {"accepted": False, "reason": "That point falls outside the modeled area."}
    p = {"lat": lat, "lon": lon}
    p.update(_arrival_payload(lat, lon, ctx))
    return {"accepted": True, "payload": p}


def validate_dam_warning_point(lat, lon, ctx):
    if not _within_modeled_area(lat, lon):
        return {"accepted": False, "reason": "That point falls outside the modeled area."}
    snap = RV.nearest_facility(lat, lon, RV.WARNING_SNAP_AMENITIES, ctx["facilities_geojson"], RULES["WARNING_SNAP_MAX_M"])
    site_lat, site_lon = (snap["lat"], snap["lon"]) if snap.get("found") else (lat, lon)
    p = {"lat": site_lat, "lon": site_lon,
         "snapped_facility_name": snap.get("name") if snap.get("found") else None}
    p.update(_arrival_payload(site_lat, site_lon, ctx))
    return {"accepted": True, "payload": p}


def validate_dam_evac_zone(lat, lon, ctx):
    if not _within_modeled_area(lat, lon):
        return {"accepted": False, "reason": "That point falls outside the modeled area."}
    p = {"lat": lat, "lon": lon}
    p.update(_arrival_payload(lat, lon, ctx))
    return {"accepted": True, "payload": p}


def validate_dam_crossing_closure(lat, lon, ctx):
    """A crossing closure only makes sense over the real channel, and
    only while the gates are actually open (severity above the safe
    release threshold) -- this checks the release, not water depth."""
    severity = ctx.get("dam_severity")
    if severity is not None and severity <= 0:
        return {
            "accepted": False,
            "reason": "No active release above the safe-release threshold yet -- currents here are not considered dangerous.",
        }
    d = _waterway_distance_m(lat, lon, ctx)
    if d is None or d > RULES["CROSSING_SNAP_MAX_M"]:
        return {
            "accepted": False,
            "reason": f"That point is {round(d or 0)}m from the nullah -- a crossing closure goes on a footbridge or informal crossing over the channel.",
        }
    p = {"lat": lat, "lon": lon, "waterway_distance_m": round(d)}
    p.update(_arrival_payload(lat, lon, ctx))
    return {"accepted": True, "payload": p}


def validate_dam_rally_point(lat, lon, ctx):
    """High ground the surge cannot reach, that people can still WALK to
    from the water's edge with real reaction time to spare."""
    if not _within_modeled_area(lat, lon):
        return {"accepted": False, "reason": "That point falls outside the modeled area."}
    if _depth_at(lat, lon, ctx) > 0:
        return {"accepted": False, "reason": "That point is under water -- a rally point has to be on ground the surge cannot reach."}

    d = _waterway_distance_m(lat, lon, ctx)
    if d is None:
        return {"accepted": False, "reason": "Cannot check reachability from the nullah."}
    walk_minutes = (d / 1000.0 / RULES["WALK_SPEED_KMH"]) * 60
    arrival = dam_arrival(lat, lon, current_discharge_cusecs(ctx))
    if walk_minutes > arrival["minutes"] * RULES["RALLY_REACTION_FRACTION"]:
        return {
            "accepted": False,
            "reason": (
                f"Too far from the nullah to reach on foot with reaction time to spare: "
                f"~{round(walk_minutes)} min walk against a ~{round(arrival['minutes'])} min wave arrival."
            ),
        }
    p = {"lat": lat, "lon": lon, "walk_minutes": round(walk_minutes), "waterway_distance_m": round(d)}
    p.update(_arrival_payload(lat, lon, ctx))
    return {"accepted": True, "payload": p}


VALIDATORS = {
    "damReleaseTracking": validate_dam_release_tracking,
    "damWarningPoint": validate_dam_warning_point,
    "damEvacZone": validate_dam_evac_zone,
    "damCrossingClosure": validate_dam_crossing_closure,
    "damRallyPoint": validate_dam_rally_point,
}

ACTION_ORDER = [
    "damEvacZone",
    "damWarningPoint",
    "damRallyPoint",
    "damCrossingClosure",
    "damReleaseTracking",
]

COVERAGE_REACH_M = {
    "damWarningPoint": DEFAULT_WARNING_RADIUS_M,
    "damEvacZone": DEFAULT_EVAC_RADIUS_M,
    "damRallyPoint": RALLY_REACH_M,
    "damCrossingClosure": CROSSING_REACH_M,
    "damReleaseTracking": 0,
}


def compute_coverage(ctx, actions):
    """Real dam-release coverage, in the same shape the other scenarios
    return so the Impact Report renders identically.

    At-risk is the same modelled surge extent the depth grid gives (dam
    release IS a channel water-level rise, like river overflow), and the
    row meanings are labelled in ROW_LABELS below.
    """
    import ai_response_evaluator as EV

    at_risk = ctx.get("_dam_at_risk")
    if at_risk is None:
        at_risk = EV.river_overflow_at_risk_buildings(ctx["depth_grid"], ctx["depth_meta"], ctx["buildings_geojson"])
        ctx["_dam_at_risk"] = at_risk
    total = len(at_risk)

    def by(t):
        return [a for a in actions if a.get("type") == t]

    def covered(acts, reach):
        if not acts:
            return 0
        n = 0
        for pt in at_risk:
            if any(RV.distance_m(a["lon"], a["lat"], pt["lon"], pt["lat"]) <= reach for a in acts):
                n += 1
        return n

    evac = covered(by("damEvacZone"), DEFAULT_EVAC_RADIUS_M)
    warn = covered(by("damWarningPoint"), DEFAULT_WARNING_RADIUS_M)
    rally = covered(by("damRallyPoint"), RALLY_REACH_M)
    # Closures placed, and the real crossings they are measured against.
    closure_acts = by("damCrossingClosure")
    crossings = len(closure_acts)
    all_crossings = crossing_points(ctx)
    crossings_total = len(all_crossings)
    crossings_closed = sum(
        1 for c in all_crossings
        if any(RV.distance_m(a["lon"], a["lat"], c["lon"], c["lat"]) <= CROSSING_REACH_M
               for a in closure_acts)
    )

    def pct(n):
        return round((n / total) * 100) if total else 0

    return {
        "total_buildings": total,
        "total_people": round(total * RV.PEOPLE_PER_BUILDING_ESTIMATE),
        "roads": {"total": crossings_total,
                  "open": crossings_total - crossings_closed,
                  "closed": crossings_closed,
                  "percent": round(100 * crossings_closed / crossings_total) if crossings_total else 0},
        "evacuation": {"covered": evac, "percent": pct(evac)},
        "warning": {"covered": warn, "percent": pct(warn)},
        "rescue": {"covered": rally, "percent": pct(rally)},   # rally-point reach
        "relief": {"covered": crossings, "percent": 0},        # crossings closed (count, not %)
    }


ROW_LABELS = {
    "evacuation": "Buildings inside a time-tiered evacuation zone",
    "warning": "Buildings within dam-release warning range",
    "rescue": "Buildings within walking reach of a rally point",
    "relief": "Dangerous crossings closed",
    "roads": "Crossings closed",
}
