"""
Response Plan validation -- RAINFALL.

A real port of PlanWorkspace.js's own rainfall response resolvers
(resolveRainWarning / resolveRainEvacZone / resolveRainRoadClosure /
resolveRainWaterRescue / resolveRainMedicalPost / resolveRainReliefCamp)
and RESPONSE_RULES.rainfall, so the AI Strategist validates its own
proposals against EXACTLY the rules a human click already faces --
the same discipline response_validation.py applied for river_overflow.

Rainfall is NOT the bathtub flood model. It has no modelled water level
or flood extent: risk lives in the terrain-derived drainage-risk zones
and the mapped underpass/road-sag low points, and every action is gated
on the real PMD 24-hour rainfall BAND rather than a depth. That is why
this is a separate module rather than more branches inside
response_validation.py.
"""
import json
import math
import os

import response_validation as RV

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# These two layers are OUTPUTS of Backend/scripts/build_drainage_risk.py
# -- the backend reading back its own generated product, not reaching
# into frontend-owned assets. The script writes them into the frontend's
# public/data so the browser can fetch them; there is no second copy.
_FRONTEND_DATA = os.path.join(BACKEND_DIR, "..", "Frontend", "mohafizweb", "public", "data")

RULES = {
    "WARNING_MIN_BAND": "moderate",
    "EVAC_MIN_BAND": "heavy",
    "ROAD_MIN_BAND": "heavy",
    "RESCUE_MIN_BAND": "very_heavy",
    "ROAD_SNAP_MAX_M": 20,
    "LOW_POINT_SNAP_MAX_M": 30,
    "ALT_ROUTE_SEARCH_M": 150,
    "RESCUE_ADJACENCY_M": 60,
    "RESCUE_MIN_RISK_CLASS": "high",
    "EVAC_ZONE_EXISTS_MAX_M": 2000,
    "WARNING_SNAP_MAX_M": 80,
    "SHELTER_SNAP_MAX_M": 80,
    "SAME_TYPE_OVERLAP_M": 30,
}

BAND_ORDER = ["light", "moderate", "heavy", "very_heavy", "extremely_heavy"]
RISK_CLASS_ORDER = {"low": 0, "moderate": 1, "high": 2, "severe": 3}

# Real coverage reach per rainfall action, mirroring the same fixed
# service reaches the river_overflow side already uses so the rainfall
# impact report is measured on the same footing.
DEFAULT_WARNING_RADIUS_M = 400
DEFAULT_EVAC_RADIUS_M = 300
RESCUE_STAGING_REACH_M = 500
RELIEF_MEDICAL_REACH_M = 800

_risk_cache = None
_low_points_cache = None


def load_drainage_risk():
    global _risk_cache
    if _risk_cache is None:
        with open(os.path.join(_FRONTEND_DATA, "drainage_risk.geojson"), encoding="utf-8") as f:
            _risk_cache = json.load(f)
    return _risk_cache


def load_road_low_points():
    global _low_points_cache
    if _low_points_cache is None:
        with open(os.path.join(_FRONTEND_DATA, "road_low_points.geojson"), encoding="utf-8") as f:
            _low_points_cache = json.load(f)
    return _low_points_cache


def band_at_least(band, minimum):
    """True when the scenario's real PMD band is at or above `minimum`."""
    try:
        return BAND_ORDER.index(band or "") >= BAND_ORDER.index(minimum)
    except ValueError:
        return False


def _band_rejection(band, minimum, what):
    return (
        f"{what} needs at least a '{minimum.replace('_', ' ')}' rainfall band. "
        f"This simulation is '{band or 'unknown'}'."
    )


def _polygon_contains(lon, lat, geom):
    """Ray-cast point-in-polygon for a GeoJSON Polygon/MultiPolygon,
    outer ring only (the risk zones are simple filled cells)."""
    if geom["type"] == "Polygon":
        rings = [geom["coordinates"][0]]
    elif geom["type"] == "MultiPolygon":
        rings = [poly[0] for poly in geom["coordinates"]]
    else:
        return False
    for ring in rings:
        inside = False
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if (y1 > lat) != (y2 > lat):
                xin = (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1
                if lon < xin:
                    inside = not inside
        if inside:
            return True
    return False


def point_inside_any_risk_zone(lat, lon):
    """Ports isPointInsideAnyRiskZone -- returns the containing feature
    or None."""
    for f in load_drainage_risk().get("features", []):
        if _polygon_contains(lon, lat, f["geometry"]):
            return f
    return None


def _zone_centroid_distance_m(lat, lon, feature):
    p = feature.get("properties") or {}
    clon, clat = p.get("centroid_lon"), p.get("centroid_lat")
    if clon is None or clat is None:
        return float("inf")
    return RV.distance_m(lon, lat, clon, clat)


def risk_zones_near(lat, lon, radius_m):
    """Ports riskZonesNear -- zones whose polygon contains the point, or
    whose centroid is within radius_m of it."""
    out = []
    for f in load_drainage_risk().get("features", []):
        if _polygon_contains(lon, lat, f["geometry"]) or _zone_centroid_distance_m(lat, lon, f) <= radius_m:
            out.append(f)
    return out


def nearest_low_point(lat, lon, max_m):
    """Ports nearestLowPoint against the real underpass/road-sag layer."""
    best, best_d = None, None
    for f in load_road_low_points().get("features", []):
        c = f["geometry"]["coordinates"]
        d = RV.distance_m(lon, lat, c[0], c[1])
        if best_d is None or d < best_d:
            best, best_d = f, d
    if best is None or best_d is None or best_d > max_m:
        return {"found": False, "distance_m": best_d}
    return {"found": True, "distance_m": best_d, "props": best.get("properties") or {}, "feature": best}


def nearest_risk_zone_distance_m(lat, lon):
    best = None
    for f in load_drainage_risk().get("features", []):
        if _polygon_contains(lon, lat, f["geometry"]):
            return 0.0
        d = _zone_centroid_distance_m(lat, lon, f)
        if best is None or d < best:
            best = d
    return best


# ---------------------------------------------------------------------
# Validators. Same (accepted / reason / payload) contract as
# response_validation.VALIDATORS, so the Strategist can call either set
# without knowing which scenario it is running.
# ---------------------------------------------------------------------

def validate_rain_warning(lat, lon, ctx):
    band = ctx.get("rainfall_band")
    if not band_at_least(band, RULES["WARNING_MIN_BAND"]):
        return {"accepted": False, "reason": _band_rejection(band, RULES["WARNING_MIN_BAND"], "A warning broadcast")}
    snap = RV.nearest_facility(lat, lon, RV.WARNING_SNAP_AMENITIES, ctx["facilities_geojson"], RULES["WARNING_SNAP_MAX_M"])
    site_lat, site_lon = (snap["lat"], snap["lon"]) if snap.get("found") else (lat, lon)
    return {
        "accepted": True,
        "payload": {
            "lat": site_lat, "lon": site_lon,
            "snapped_facility_name": snap.get("name") if snap.get("found") else None,
        },
    }


def validate_rain_evac_zone(lat, lon, ctx):
    band = ctx.get("rainfall_band")
    if not band_at_least(band, RULES["EVAC_MIN_BAND"]):
        return {"accepted": False, "reason": _band_rejection(band, RULES["EVAC_MIN_BAND"], "A priority evacuation zone")}
    inside = point_inside_any_risk_zone(lat, lon)
    if not inside:
        return {
            "accepted": False,
            "reason": "That point does not overlap a mapped drainage-risk zone. Rainfall floods pool at specific low points, not the whole sector.",
        }
    p = inside.get("properties") or {}
    return {
        "accepted": True,
        "payload": {"lat": lat, "lon": lon, "zone_class": p.get("risk_class"), "zone_max_sink_m": p.get("max_sink_m")},
    }


def validate_rain_road_closure(lat, lon, ctx):
    band = ctx.get("rainfall_band")
    if not band_at_least(band, RULES["ROAD_MIN_BAND"]):
        return {"accepted": False, "reason": _band_rejection(band, RULES["ROAD_MIN_BAND"], "A road closure")}
    road = RV.nearest_road(lat, lon, RULES["ROAD_SNAP_MAX_M"], ctx["roads_geojson"])
    if not road.get("found"):
        return {"accepted": False, "reason": "That point is not on a mapped road."}
    low = nearest_low_point(road["lat"], road["lon"], RULES["LOW_POINT_SNAP_MAX_M"])
    if not low.get("found"):
        return {
            "accepted": False,
            "reason": "That road is not flagged as an underpass or low point -- rainfall floods pool at specific points, not along every road.",
        }
    props = low["props"]
    return {
        "accepted": True,
        "payload": {
            "lat": road["lat"], "lon": road["lon"],
            "road_name": road.get("name"), "road_highway_type": road.get("highway_type"),
            "road_u": road.get("u"), "road_v": road.get("v"),
            "low_point_kind": props.get("kind"), "drop_m": props.get("drop_m"),
        },
    }


def validate_rain_water_rescue(lat, lon, ctx):
    band = ctx.get("rainfall_band")
    if not band_at_least(band, RULES["RESCUE_MIN_BAND"]):
        return {"accepted": False, "reason": _band_rejection(band, RULES["RESCUE_MIN_BAND"], "A water rescue staging point")}
    nearby = risk_zones_near(lat, lon, RULES["RESCUE_ADJACENCY_M"])
    min_rank = RISK_CLASS_ORDER[RULES["RESCUE_MIN_RISK_CLASS"]]
    deep = [f for f in nearby if RISK_CLASS_ORDER.get((f.get("properties") or {}).get("risk_class"), -1) >= min_rank]
    if not deep:
        return {
            "accepted": False,
            "reason": (
                f"No '{RULES['RESCUE_MIN_RISK_CLASS']}' or deeper drainage-risk zone within "
                f"{RULES['RESCUE_ADJACENCY_M']}m -- not deep enough to plausibly need water rescue."
            ),
        }
    deep.sort(key=lambda f: RISK_CLASS_ORDER.get((f.get("properties") or {}).get("risk_class"), -1), reverse=True)
    best = deep[0].get("properties") or {}
    return {
        "accepted": True,
        "payload": {"lat": lat, "lon": lon, "zone_class": best.get("risk_class"), "zone_max_sink_m": best.get("max_sink_m")},
    }


def _require_near_evac_zone(lat, lon, ctx):
    """Ports requireNearRainfallEvacZone -- a medical post / relief camp
    only makes sense near people who are actually being evacuated."""
    zones = ctx.get("existing_evac_zones") or []
    if not zones:
        return None, {
            "accepted": False,
            "reason": "Needs a priority evacuation zone placed nearby first -- a post with nobody being evacuated to it helps no one.",
        }
    best = min(RV.distance_m(lon, lat, z["lon"], z["lat"]) for z in zones)
    if best > RULES["EVAC_ZONE_EXISTS_MAX_M"]:
        return None, {
            "accepted": False,
            "reason": f"Nearest evacuation zone is {round(best)}m away -- further than the {RULES['EVAC_ZONE_EXISTS_MAX_M']}m this can serve.",
        }
    return best, None


def _shared_post_checks(lat, lon, ctx, what):
    nearest_zone_m, rejection = _require_near_evac_zone(lat, lon, ctx)
    if rejection:
        return None, rejection
    if point_inside_any_risk_zone(lat, lon):
        return None, {
            "accepted": False,
            "reason": f"That point is inside a mapped drainage-risk zone -- a {what} must sit on ground that stays dry.",
        }
    road = RV.nearest_road(lat, lon, RULES["ROAD_SNAP_MAX_M"] * 5, ctx["roads_geojson"])
    if not road.get("found"):
        return None, {"accepted": False, "reason": f"No road access within reach -- a {what} has to be reachable by vehicle."}
    return {"nearest_zone_m": nearest_zone_m, "road": road}, None


def validate_rain_medical_post(lat, lon, ctx):
    ok, rejection = _shared_post_checks(lat, lon, ctx, "medical post")
    if rejection:
        return rejection
    return {
        "accepted": True,
        "payload": {
            "lat": lat, "lon": lon,
            "nearest_zone_m": ok["nearest_zone_m"],
            "road_name": ok["road"].get("name"),
        },
    }


def validate_rain_relief_camp(lat, lon, ctx):
    ok, rejection = _shared_post_checks(lat, lon, ctx, "shelter")
    if rejection:
        return rejection
    snap = RV.nearest_facility(lat, lon, RV.SHELTER_AMENITIES, ctx["facilities_geojson"], RULES["SHELTER_SNAP_MAX_M"])
    site_lat, site_lon = lat, lon
    snapped_name = None
    if snap.get("found") and not point_inside_any_risk_zone(snap["lat"], snap["lon"]):
        site_lat, site_lon, snapped_name = snap["lat"], snap["lon"], snap.get("name")
    return {
        "accepted": True,
        "payload": {
            "lat": site_lat, "lon": site_lon,
            "nearest_zone_m": ok["nearest_zone_m"],
            "snapped_facility_name": snapped_name,
            "road_name": ok["road"].get("name"),
        },
    }


VALIDATORS = {
    "rainWarning": validate_rain_warning,
    "rainEvacZone": validate_rain_evac_zone,
    "rainRoadClosure": validate_rain_road_closure,
    "rainWaterRescue": validate_rain_water_rescue,
    "rainMedicalPost": validate_rain_medical_post,
    "rainReliefCamp": validate_rain_relief_camp,
}

ACTION_ORDER = [
    "rainEvacZone",      # first: the posts below require one nearby
    "rainWarning",
    "rainRoadClosure",
    "rainWaterRescue",
    "rainMedicalPost",
    "rainReliefCamp",
]

COVERAGE_REACH_M = {
    "rainWarning": DEFAULT_WARNING_RADIUS_M,
    "rainEvacZone": DEFAULT_EVAC_RADIUS_M,
    "rainWaterRescue": RESCUE_STAGING_REACH_M,
    "rainMedicalPost": RELIEF_MEDICAL_REACH_M,
    "rainReliefCamp": RELIEF_MEDICAL_REACH_M,
    "rainRoadClosure": 0,
}


# Rainfall's at-risk radius around a mapped drainage-risk zone.
#
# Strictly "inside the risk polygon" is unusable here, and that is a
# property of the real data, not a modelling shortcut: the 252 mapped
# zones total only ~0.98 km2 across the whole modelled area and sit
# mostly on undeveloped low ground, so a strict test finds almost no
# buildings at all. The zones mark where water POOLS; the buildings
# actually affected are the ones around that pooling point, which is
# what this radius represents. Stated openly as a constant rather than
# buried, because it is a real assumption a reviewer should be able to
# challenge -- and it is the ONLY assumption here; everything else is
# measured.
AT_RISK_RADIUS_M = 150


_at_risk_cache = None


def at_risk_buildings(buildings_geojson):
    """Rainfall's equivalent of the flood extent: every building within
    AT_RISK_RADIUS_M of a mapped drainage-risk zone. This is the set the
    rainfall impact report measures coverage against.

    Uses response_validation._feature_centroid rather than reading
    coordinates directly: only 16 of the ~4,900 building features are
    Points, the rest are Polygons, so a Point-only reader silently saw
    almost nothing.
    """
    # Cached: this is ~4,900 buildings x 252 zones of distance maths and
    # it does not change within a process (both inputs are themselves
    # module-level cached loads). Recomputing it per action type made a
    # single rainfall request spend minutes here and blow its own time
    # budget before the model was ever called.
    global _at_risk_cache
    if _at_risk_cache is not None:
        return _at_risk_cache

    zones = [
        (z["properties"]["centroid_lon"], z["properties"]["centroid_lat"])
        for z in load_drainage_risk().get("features", [])
        if (z.get("properties") or {}).get("centroid_lon") is not None
    ]
    # Degree-space prefilter before the real metre distance: at this
    # latitude AT_RISK_RADIUS_M is a tiny delta, so most zone/building
    # pairs can be discarded with two float compares instead of a
    # trig-free-but-still-costly distance call.
    deg_pad = (AT_RISK_RADIUS_M / 111320.0) * 1.6

    out = []
    for f in (buildings_geojson or {}).get("features", []):
        c = RV._feature_centroid(f)
        if c is None:
            continue
        lon, lat = c[0], c[1]
        for zlon, zlat in zones:
            if abs(zlat - lat) > deg_pad or abs(zlon - lon) > deg_pad:
                continue
            if RV.distance_m(lon, lat, zlon, zlat) <= AT_RISK_RADIUS_M:
                out.append({"lon": lon, "lat": lat})
                break

    _at_risk_cache = out
    return out
