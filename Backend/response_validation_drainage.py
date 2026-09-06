"""
Response Plan validation -- DRAINAGE FAILURE.

A real port of PlanWorkspace.js's drainage-failure response resolvers
(resolveDrainBlockageClearance / resolveDrainPumpDeployment /
resolveDrainSewerOverflow / resolveDrainVectorControl / resolveDrainBypass)
and RESPONSE_RULES.drainage_failure, so the AI Strategist validates
against EXACTLY the rules a human click already faces.

Unlike rainfall, drainage failure DOES use the live flood-depth grid --
this cause type IS the drain/channel network being overwhelmed, so the
bathtub-over-terrain model is physically appropriate here (the same
reasoning the frontend's own RESPONSE_RULES comment gives). The
drainage-risk zones and chronic low points are reused from the rainfall
layers, because the geography does not change between scenarios.
"""
import response_validation as RV
import response_validation_rainfall as RVR
import prevention_validation as PV
from shapely.geometry import Point

RULES = {
    "ROAD_SNAP_MAX_M": 20,
    "CULVERT_HIGH_CAPACITY_CLASSES": ["trunk", "primary", "secondary"],
    "CULVERT_WATERWAY_MAX_M": 15,
    "LOW_POINT_SNAP_MAX_M": 30,
    "JUNCTION_SNAP_MAX_M": 25,
    "JUNCTION_MIN_DEGREE": 3,
    "BYPASS_SEARCH_MAX_M": 500,
    "SAME_TYPE_OVERLAP_M": 30,
}

# Matches the frontend's DRAIN_INTERVENTION_REACH_M exactly -- how far a
# clearance/pump/bypass counts as treating a drainage-risk zone.
INTERVENTION_REACH_M = 150


def _depth_at(lat, lon, ctx):
    d = RV.depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    return d if d is not None else 0.0


def _is_wet(lat, lon, ctx):
    return _depth_at(lat, lon, ctx) > 0


def _nearest_waterway_distance_m(lat, lon, ctx):
    ww = ctx.get("waterways_geojson")
    if not ww:
        import flood_engine
        ww = flood_engine.load_waterways()
        ctx["waterways_geojson"] = ww
    return PV.nearest_line_distance_m(Point(lon, lat), ww)


def validate_drain_blockage_clearance(lat, lon, ctx):
    """A culvert worth dispatching a crew to: a HIGH-CAPACITY road
    crossing the nullah, that is currently backing up."""
    road = RV.nearest_road(lat, lon, RULES["ROAD_SNAP_MAX_M"], ctx["roads_geojson"])
    if not road.get("found"):
        return {"accepted": False, "reason": "Not on a mapped road -- a culvert clearance goes where a road crosses the nullah."}
    ww_d = _nearest_waterway_distance_m(road["lat"], road["lon"], ctx)
    if ww_d is None or ww_d > RULES["CULVERT_WATERWAY_MAX_M"]:
        return {"accepted": False, "reason": f"That road point is {round(ww_d or 0)}m from the mapped nullah -- too far to be a culvert crossing."}
    if not _is_wet(road["lat"], road["lon"], ctx):
        return {"accepted": False, "reason": "No water is piling up at this culvert -- nothing to clear."}
    hw = road.get("highway_type")
    if hw not in RULES["CULVERT_HIGH_CAPACITY_CLASSES"]:
        return {
            "accepted": False,
            "reason": f"This culvert carries a {hw} road (lower capacity by design) -- some backup here is expected, not a capacity mismatch worth a crew.",
        }
    return {
        "accepted": True,
        "payload": {
            "lat": road["lat"], "lon": road["lon"],
            "road_name": road.get("name"), "road_highway_type": hw,
            "road_u": road.get("u"), "road_v": road.get("v"),
            "depth_m": round(_depth_at(road["lat"], road["lon"], ctx), 1),
        },
    }


def validate_drain_pump_deployment(lat, lon, ctx):
    """Pumps go to real chronic low points -- the places water actually
    collects, from the same terrain-derived layer rainfall uses."""
    low = RVR.nearest_low_point(lat, lon, RULES["LOW_POINT_SNAP_MAX_M"])
    if not low.get("found"):
        return {"accepted": False, "reason": "Not at a known chronic low point -- pumps go where water actually collects."}
    props = low["props"]
    return {
        "accepted": True,
        "payload": {
            "lat": lat, "lon": lon,
            "low_point_kind": props.get("kind"), "drop_m": props.get("drop_m"),
            "depth_m": round(_depth_at(lat, lon, ctx), 1),
        },
    }


def validate_drain_sewer_overflow(lat, lon, ctx):
    """A flagged overflow point is a real road JUNCTION (the stand-in
    for a manhole, since no sewer-network data exists) that the live
    depth grid currently shows wet."""
    j = nearest_junction(lat, lon, RULES["JUNCTION_SNAP_MAX_M"], RULES["JUNCTION_MIN_DEGREE"], ctx)
    if not j.get("found"):
        return {"accepted": False, "reason": "Not at a mapped road junction -- overflow points are flagged at junctions (the manhole stand-in)."}
    if not _is_wet(j["lat"], j["lon"], ctx):
        return {"accepted": False, "reason": "No water is registering at this junction -- nothing overflowing to flag."}
    return {
        "accepted": True,
        "payload": {"lat": j["lat"], "lon": j["lon"], "degree": j["degree"], "depth_m": round(_depth_at(j["lat"], j["lon"], ctx), 1)},
    }


def validate_drain_vector_control(lat, lon, ctx):
    """Standing water only -- there is nothing to treat on dry ground."""
    if not _is_wet(lat, lon, ctx):
        return {"accepted": False, "reason": "No standing water at that point -- nothing to flag for vector control."}
    return {"accepted": True, "payload": {"lat": lat, "lon": lon, "depth_m": round(_depth_at(lat, lon, ctx), 1)}}


def validate_drain_bypass(lat, lon, ctx):
    """A bypass connects a flooded low point to somewhere it can drain,
    so the origin itself must actually be flooded."""
    if not _is_wet(lat, lon, ctx):
        return {"accepted": False, "reason": "That point is not currently flooded -- a bypass drains a flooded low point, not dry ground."}
    ww_d = _nearest_waterway_distance_m(lat, lon, ctx)
    if ww_d is None or ww_d > RULES["BYPASS_SEARCH_MAX_M"]:
        return {"accepted": False, "reason": "No mapped nullah within reach to bypass into."}
    return {
        "accepted": True,
        "payload": {"lat": lat, "lon": lon, "waterway_distance_m": round(ww_d), "depth_m": round(_depth_at(lat, lon, ctx), 1)},
    }


_junction_cache = None


def road_junctions(ctx):
    """Real road-graph junctions with their degree, from the same roads
    GeoJSON every other check reads. Cached -- this walks every
    LineString endpoint and does not change within a process."""
    global _junction_cache
    if _junction_cache is not None:
        return _junction_cache

    counts = {}
    for f in (ctx.get("roads_geojson") or {}).get("features", []):
        geom = f.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        for c in (coords[0], coords[-1]):
            key = (round(c[0], 6), round(c[1], 6))
            counts[key] = counts.get(key, 0) + 1

    _junction_cache = [
        {"lon": k[0], "lat": k[1], "degree": v}
        for k, v in counts.items()
    ]
    return _junction_cache


def nearest_junction(lat, lon, max_m, min_degree, ctx):
    best, best_d = None, None
    for j in road_junctions(ctx):
        if j["degree"] < min_degree:
            continue
        d = RV.distance_m(lon, lat, j["lon"], j["lat"])
        if best_d is None or d < best_d:
            best, best_d = j, d
    if best is None or best_d > max_m:
        return {"found": False, "distance_m": best_d}
    return {"found": True, "distance_m": best_d, "lat": best["lat"], "lon": best["lon"], "degree": best["degree"]}


VALIDATORS = {
    "drainBlockageClearance": validate_drain_blockage_clearance,
    "drainPumpDeployment": validate_drain_pump_deployment,
    "drainSewerOverflow": validate_drain_sewer_overflow,
    "drainVectorControl": validate_drain_vector_control,
    "drainBypass": validate_drain_bypass,
}

ACTION_ORDER = [
    "drainBlockageClearance",
    "drainPumpDeployment",
    "drainBypass",
    "drainSewerOverflow",
    "drainVectorControl",
]

# Only the three physical interventions treat an area; the two marker
# actions (overflow flag, vector control) are measured by their own
# counts in the coverage below, not by a radius.
COVERAGE_REACH_M = {
    "drainBlockageClearance": INTERVENTION_REACH_M,
    "drainPumpDeployment": INTERVENTION_REACH_M,
    "drainBypass": INTERVENTION_REACH_M,
    "drainSewerOverflow": RULES["JUNCTION_SNAP_MAX_M"],
    "drainVectorControl": INTERVENTION_REACH_M,
}

INTERVENTION_TYPES = ("drainBlockageClearance", "drainPumpDeployment", "drainBypass")


def compute_coverage(ctx, actions):
    """Real drainage-failure coverage, mirroring the frontend's own
    computeDrainageFailureResponseCoverage: how much of the mapped
    drainage-risk AREA an intervention actually reaches, and how many of
    the real wet junctions have been flagged as overflow points.

    Returned in the same {covered, percent} shape the other scenarios
    use so the Impact Report renders identically -- only the meaning of
    each row differs, which the row labels make explicit.
    """
    zones = RVR.load_drainage_risk().get("features", [])
    interventions = [a for a in actions if a.get("type") in INTERVENTION_TYPES]
    overflow_markers = [a for a in actions if a.get("type") == "drainSewerOverflow"]
    vector_points = [a for a in actions if a.get("type") == "drainVectorControl"]

    total_area = 0.0
    addressed_area = 0.0
    for z in zones:
        p = z.get("properties") or {}
        area = float(p.get("area_m2") or 0)
        total_area += area
        zlon, zlat = p.get("centroid_lon"), p.get("centroid_lat")
        if zlon is None:
            continue
        if any(RV.distance_m(a["lon"], a["lat"], zlon, zlat) <= INTERVENTION_REACH_M for a in interventions):
            addressed_area += area
    area_pct = round((addressed_area / total_area) * 100) if total_area > 0 else 0

    # Real wet junctions -- the same precondition validate_drain_sewer_overflow
    # itself enforces, so this walks the identical set rather than a
    # separately-invented list.
    wet_junctions = [
        j for j in road_junctions(ctx)
        if j["degree"] >= RULES["JUNCTION_MIN_DEGREE"] and _is_wet(j["lat"], j["lon"], ctx)
    ]
    warned = sum(
        1 for j in wet_junctions
        if any(RV.distance_m(m["lon"], m["lat"], j["lon"], j["lat"]) <= RULES["JUNCTION_SNAP_MAX_M"] for m in overflow_markers)
    )
    total_overflow = len(wet_junctions)
    warned_pct = round((warned / total_overflow) * 100) if total_overflow else 0

    at_risk = ctx.get("_drain_at_risk")
    if at_risk is None:
        import ai_response_evaluator as EV
        at_risk = EV.river_overflow_at_risk_buildings(ctx["depth_grid"], ctx["depth_meta"], ctx["buildings_geojson"])
        ctx["_drain_at_risk"] = at_risk
    total_buildings = len(at_risk)

    def covered_count(acts, reach):
        if not acts:
            return 0
        n = 0
        for pt in at_risk:
            if any(RV.distance_m(a["lon"], a["lat"], pt["lon"], pt["lat"]) <= reach for a in acts):
                n += 1
        return n

    treated = covered_count(interventions, INTERVENTION_REACH_M)
    vector_covered = covered_count(vector_points, INTERVENTION_REACH_M)

    def pct(n):
        return round((n / total_buildings) * 100) if total_buildings else 0

    return {
        "total_buildings": total_buildings,
        "total_people": round(total_buildings * RV.PEOPLE_PER_BUILDING_ESTIMATE),
        "roads": {"total": total_overflow, "open": total_overflow - warned, "closed": warned,
                  "percent": round(100 * warned / total_overflow) if total_overflow else 0},
        # Row meanings for drainage failure, kept in the shared key names
        # so the existing report renders without a special case:
        "evacuation": {"covered": round(addressed_area), "percent": area_pct},      # drainage-risk area treated
        "warning": {"covered": warned, "percent": warned_pct},                       # overflow points flagged
        "rescue": {"covered": treated, "percent": pct(treated)},                     # buildings near an intervention
        "relief": {"covered": vector_covered, "percent": pct(vector_covered)},       # buildings near vector control
    }


# Labels the UI should use for this scenario's rows, since the shared
# keys mean something different here.
ROW_LABELS = {
    "evacuation": "Drainage-risk area treated",
    "warning": "Sewer/manhole overflow points flagged",
    "rescue": "Buildings near a clearance/pump/bypass",
    "relief": "Buildings near vector control",
    "roads": "Wet junctions flagged",
}
