"""
Response Plan validation -- Part 0 of the Response-side multi-agent AI
comparison (Hazard Reader / Strategist / Impact Evaluator).

This is a real, careful port of PlanWorkspace.js's Response Plan
validation logic (RESPONSE_RULES.river_overflow, isPointInFloodExtent,
isPointOnSafeGround, nearestRoad, nearestFacility, and each of the 5
implemented river_overflow action resolvers: resolveWarningPoint,
resolveEvacuationZone, resolveCloseFloodedRoad, resolveBoatLaunch,
resolveReliefMedicalPost) -- so a server-side AI agent can validate its
own candidate response-plan placements against EXACTLY the rules a
human click on the map already faces, the same way prevention_validation.py
did for the AI Prevention Proposer.

Only river_overflow is ported. The frontend itself only treats
river_overflow and rainfall as validated so far (see PlanWorkspace.js's
own "Response actions are only validated for..." banner), and rainfall
uses a completely different drainage-risk-band system (PMD/FFD 24-hour
bands, not a modelled water level) -- porting it is a separate task, not
silently approximated here.
"""
import math

import numpy as np
from shapely.geometry import Point, LineString

import flood_engine
from prevention_validation import distance_m, _project_local

# Mirrors PlanWorkspace.js RESPONSE_RULES.river_overflow exactly (see
# that file for the reasoning behind each number -- duplicated here only
# as data, not re-derived).
RULES = {
    "IMPASSABLE_ROAD_DEPTH_M": 1,
    "ROAD_SNAP_MAX_M": 20,
    "BOAT_WATER_ADJACENCY_M": 40,
    "BOAT_ROAD_ACCESS_MAX_M": 60,
    "SAFE_GROUND_CLEARANCE_M": 40,
    "SHELTER_SNAP_MAX_M": 80,
    "EVAC_ZONE_EXISTS_MAX_M": 2000,
    "WARNING_SNAP_MAX_M": 80,
    "SAME_TYPE_OVERLAP_M": 30,
}

WARNING_SNAP_AMENITIES = ["place_of_worship", "community_centre", "school", "college", "university"]
SHELTER_AMENITIES = ["school", "college", "university", "community_centre", "shelter", "place_of_worship"]
EVAC_HOSPITAL_AMENITIES = ["hospital", "clinic", "doctors"]
PEOPLE_PER_BUILDING_ESTIMATE = 6.5

# Real SERVICE/COVERAGE reach -- "how far does this action's benefit
# extend" -- as opposed to the PLACEMENT constraints in RULES above
# ("how far can this action be from X to be considered valid there").
# These are a genuinely different concept from e.g. RULES["BOAT_WATER_
# ADJACENCY_M"] (a placement check) and must not be confused with it --
# an earlier draft of ai_response_hazard_reader.py did exactly that.
# Matches PlanWorkspace.js's own RESCUE_STAGING_REACH_M /
# RELIEF_MEDICAL_REACH_M / default coverageRadiusM / default radiusM
# exactly, so an AI-proposed action's reported coverage always matches
# what the same action would report if placed by hand.
RESCUE_STAGING_REACH_M = 500
RELIEF_MEDICAL_REACH_M = 800
DEFAULT_WARNING_RADIUS_M = 400
DEFAULT_EVAC_RADIUS_M = 300


def action_coverage_radius_m(action):
    """Real reach of one response action, for 'does this already cover
    zone X' checks -- reads a placed action's OWN radius when it has one
    (evacuationZone/warningPoint), from whichever of the real key
    conventions is present (the frontend's camelCase marker.params, or
    the Strategist's snake_case parameters), falling back to the same
    real default every tool's own form field uses. closeRoad/boatLaunch/
    reliefMedicalPost have no user-set radius -- their fixed real
    service reach is used instead."""
    atype = action.get("type")
    params = action.get("params") or action.get("parameters") or {}
    if atype == "warningPoint":
        v = params.get("coverage_radius_m", params.get("coverageRadiusM"))
        return float(v) if v is not None else DEFAULT_WARNING_RADIUS_M
    if atype == "evacuationZone":
        v = params.get("radius_m", params.get("radiusM"))
        return float(v) if v is not None else DEFAULT_EVAC_RADIUS_M
    if atype == "closeRoad":
        return RULES["ROAD_SNAP_MAX_M"]
    if atype == "boatLaunch":
        return RESCUE_STAGING_REACH_M
    if atype == "reliefMedicalPost":
        return RELIEF_MEDICAL_REACH_M
    return 0.0


def load_buildings_geojson():
    if "_buildings_cache" not in globals() or globals()["_buildings_cache"] is None:
        import json
        with open("buildings.geojson", encoding="utf-8") as f:
            globals()["_buildings_cache"] = json.load(f)
    return globals()["_buildings_cache"]


# ---------------------------------------------------------------------
# Depth-grid point/radius lookups -- Python equivalent of the client's
# floodGridIndex/floodDepthAtCell/scanFloodDepthNear, reading straight
# off flood_engine.compute_depth_grid's real numpy array (the same
# function /flood-depth-grid itself calls) instead of re-deriving depth
# from scratch.
# ---------------------------------------------------------------------
def _grid_rowcol(lat, lon, meta):
    west, south, east, north = meta["bounds"]
    if lon < west or lon > east or lat < south or lat > north:
        return None
    width, height = meta["width"], meta["height"]
    col = int((lon - west) / (east - west) * width)
    row = int((north - lat) / (north - south) * height)
    col = min(max(col, 0), width - 1)
    row = min(max(row, 0), height - 1)
    return row, col


def depth_at_point(lat, lon, depth_grid, meta):
    """Real water depth (m) at one point, or None if outside the study
    area or the DEM has no data there."""
    rc = _grid_rowcol(lat, lon, meta)
    if rc is None:
        return None
    d = depth_grid[rc[0], rc[1]]
    if np.isnan(d):
        return None
    return float(d)


def scan_depth_near(lat, lon, radius_m, depth_grid, meta):
    """Real max depth / nearest-wet-cell within radius_m of a point --
    ports scanFloodDepthNear's cell-window scan."""
    out = {"has_data": False, "max_depth_m": 0.0, "wet_cells": 0, "data_cells": 0, "nearest_wet_m": float("inf")}
    rc = _grid_rowcol(lat, lon, meta)
    if rc is None:
        return out

    west, south, east, north = meta["bounds"]
    width, height = meta["width"], meta["height"]
    cell_w_deg = (east - west) / width
    cell_h_deg = (north - south) / height
    m_per_deg_lon = 111320 * math.cos(math.radians(lat))
    cell_w_m = max(cell_w_deg * m_per_deg_lon, 1e-6)
    cell_h_m = max(cell_h_deg * 111320, 1e-6)
    row_span = max(1, math.ceil(radius_m / cell_h_m))
    col_span = max(1, math.ceil(radius_m / cell_w_m))
    row0, col0 = rc

    for r in range(max(0, row0 - row_span), min(height, row0 + row_span + 1)):
        cell_lat = north - (r + 0.5) * cell_h_deg
        for c in range(max(0, col0 - col_span), min(width, col0 + col_span + 1)):
            cell_lon = west + (c + 0.5) * cell_w_deg
            dx = (cell_lon - lon) * m_per_deg_lon
            dy = (cell_lat - lat) * 111320
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > radius_m:
                continue
            d = depth_grid[r, c]
            if np.isnan(d):
                continue
            out["has_data"] = True
            out["data_cells"] += 1
            if d > 0:
                out["wet_cells"] += 1
                if dist < out["nearest_wet_m"]:
                    out["nearest_wet_m"] = dist
                if d > out["max_depth_m"]:
                    out["max_depth_m"] = float(d)
    return out


def point_in_flood_extent(lat, lon, depth_grid, meta):
    """Ports isPointInFloodExtent."""
    depth = depth_at_point(lat, lon, depth_grid, meta)
    if depth is None:
        return {"ok": False, "in_flood": False, "depth_m": 0.0, "reason": "falls outside the simulated study area"}
    return {"ok": True, "in_flood": depth > 0, "depth_m": depth}


def point_on_safe_ground(lat, lon, depth_grid, meta, clearance_m=None):
    """Ports isPointOnSafeGround -- real separation from the water, not
    merely a dry cell."""
    clearance = clearance_m if clearance_m is not None else RULES["SAFE_GROUND_CLEARANCE_M"]
    here = point_in_flood_extent(lat, lon, depth_grid, meta)
    if not here["ok"]:
        return {"ok": False, "safe": False, "depth_m": 0.0, "nearest_flood_m": None, "reason": here["reason"]}
    if here["in_flood"]:
        return {
            "ok": True, "safe": False, "depth_m": here["depth_m"], "nearest_flood_m": 0.0,
            "reason": f"is inside the flood extent, under {here['depth_m']:.1f}m of water",
        }
    scan = scan_depth_near(lat, lon, clearance, depth_grid, meta)
    if scan["wet_cells"] > 0 and scan["nearest_wet_m"] <= clearance:
        return {
            "ok": True, "safe": False, "depth_m": 0.0, "nearest_flood_m": scan["nearest_wet_m"],
            "reason": f"is dry itself but only {round(scan['nearest_wet_m'])}m from floodwater (needs {clearance:g}m of clear ground)",
        }
    return {"ok": True, "safe": True, "depth_m": 0.0, "nearest_flood_m": scan["nearest_wet_m"] if scan["wet_cells"] > 0 else None}


# ---------------------------------------------------------------------
# Nearest road / facility / building-count -- ports nearestRoad,
# nearestFacility, countBuildingsWithin.
# ---------------------------------------------------------------------
def nearest_road(lat, lon, max_distance_m, roads_geojson):
    if not roads_geojson or not roads_geojson.get("features"):
        return {"found": False, "data_missing": True, "distance_m": None}

    point = Point(lon, lat)
    p_local = _project_local(point, lat)
    best = None
    for feature in roads_geojson["features"]:
        geom = feature.get("geometry")
        if not geom or geom["type"] != "LineString":
            continue
        line = LineString(geom["coordinates"])
        line_local = _project_local(line, lat)
        d = p_local.distance(line_local)
        if best is None or d < best["distance_m"]:
            frac = line_local.project(p_local, normalized=True)
            nearest_pt = line.interpolate(frac, normalized=True)
            best = {"distance_m": d, "lon": nearest_pt.x, "lat": nearest_pt.y, "feature": feature}

    if best is None:
        return {"found": False, "data_missing": True, "distance_m": None}

    props = best["feature"].get("properties") or {}
    highway = props.get("highway")
    if isinstance(highway, list):
        highway = highway[0] if highway else None
    return {
        "found": best["distance_m"] <= max_distance_m,
        "data_missing": False,
        "distance_m": best["distance_m"],
        "lat": best["lat"], "lon": best["lon"],
        "name": props.get("name"),
        "highway_type": highway or "road",
        "u": props.get("u"), "v": props.get("v"),
    }


def _feature_centroid(feature):
    """Same centroid rule the frontend's featureCentroidLonLat uses (a
    ring-vertex average, not shapely's area centroid) so this agrees
    exactly with the frontend on where a polygon facility/building "is"."""
    geom = feature.get("geometry")
    if not geom:
        return None
    if geom["type"] == "Point":
        return geom["coordinates"][0], geom["coordinates"][1]
    ring = None
    if geom["type"] == "Polygon":
        ring = geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        ring = geom["coordinates"][0][0]
    if not ring:
        return None
    sx = sum(p[0] for p in ring)
    sy = sum(p[1] for p in ring)
    return sx / len(ring), sy / len(ring)


def nearest_facility(lat, lon, amenity_types, facilities_geojson, max_distance_m=None):
    if not facilities_geojson or not facilities_geojson.get("features"):
        return {"found": False, "data_missing": True, "distance_m": None}
    best = None
    for feature in facilities_geojson["features"]:
        props = feature.get("properties") or {}
        if props.get("amenity") not in amenity_types:
            continue
        c = _feature_centroid(feature)
        if c is None:
            continue
        d = distance_m(lon, lat, c[0], c[1])
        if best is None or d < best["distance_m"]:
            best = {"distance_m": d, "lon": c[0], "lat": c[1], "name": props.get("name"), "amenity": props.get("amenity")}
    if best is None:
        return {"found": False, "data_missing": False, "distance_m": None}
    return {
        "found": max_distance_m is None or best["distance_m"] <= max_distance_m,
        "data_missing": False,
        "distance_m": best["distance_m"],
        "lat": best["lat"], "lon": best["lon"],
        "name": best["name"] or ("Unnamed " + str(best["amenity"])),
        "amenity": best["amenity"],
    }


def count_buildings_within(lat, lon, radius_m, buildings_geojson):
    if not buildings_geojson or not buildings_geojson.get("features"):
        return 0
    count = 0
    for feature in buildings_geojson["features"]:
        c = _feature_centroid(feature)
        if c is None:
            continue
        if distance_m(lon, lat, c[0], c[1]) <= radius_m:
            count += 1
    return count


def _facility_description(f):
    return f["name"] if f.get("name") else "Unnamed " + str(f.get("amenity"))


def _road_description(road):
    if not road:
        return "that road"
    return road.get("name") or str(road.get("highway_type", "road")).replace("_", " ")


def _same_type_overlap(lat, lon, existing_points, threshold_m):
    for p in existing_points or []:
        if p.get("lat") is None or p.get("lon") is None:
            continue
        if distance_m(lon, lat, p["lon"], p["lat"]) <= threshold_m:
            return True
    return False


# =====================================================================
# Per-action validators -- one per RESPONSE_TOOLS entry implemented for
# river_overflow. Each takes (lat, lon, ctx) and returns
# {"accepted": True, "payload": {...}} or {"accepted": False, "reason": "..."},
# matching the frontend resolvers' own return shape exactly so a
# rejection reason can be shown to a human exactly as-is.
#
# ctx is a dict carrying the shared real data every validator reads:
#   depth_grid, depth_meta  -- flood_engine.compute_depth_grid(water_level_m)
#   roads_geojson           -- prevention_validation.load_roads_geojson()
#   facilities_geojson      -- flood_engine.load_facilities()
#   buildings_geojson       -- load_buildings_geojson()
#   existing_closed_roads   -- [{"lat":.., "lon":..}, ...] already in the plan
#   existing_evac_zones     -- [{"lat":.., "lon":..}, ...] already in the plan
# =====================================================================

def validate_warning_point(lat, lon, ctx):
    here = point_in_flood_extent(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    if not here["ok"]:
        return {"accepted": False, "reason": f"That point {here['reason']}."}

    candidate = nearest_facility(lat, lon, WARNING_SNAP_AMENITIES, ctx["facilities_geojson"], RULES["WARNING_SNAP_MAX_M"])
    snapped = candidate if candidate["found"] else None
    site_lat, site_lon = (snapped["lat"], snapped["lon"]) if snapped else (lat, lon)
    site_flood = point_in_flood_extent(site_lat, site_lon, ctx["depth_grid"], ctx["depth_meta"]) if snapped else here

    return {
        "accepted": True,
        "payload": {
            "lat": site_lat, "lon": site_lon,
            "snapped_facility_name": _facility_description(snapped) if snapped else None,
            "snap_distance_m": snapped["distance_m"] if snapped else None,
            "self_flooded": bool(site_flood["ok"] and site_flood["in_flood"]),
            "self_flood_depth_m": site_flood["depth_m"] if site_flood["ok"] else None,
        },
    }


def warning_coverage(lat, lon, radius_m, buildings_geojson):
    """Ports computeWarningCoverage."""
    if not radius_m or radius_m <= 0:
        return {"radius_m": radius_m, "building_count": 0, "estimated_people": 0}
    count = count_buildings_within(lat, lon, radius_m, buildings_geojson)
    return {"radius_m": radius_m, "building_count": count, "estimated_people": round(count * PEOPLE_PER_BUILDING_ESTIMATE)}


def validate_evacuation_zone(lat, lon, ctx):
    here = point_in_flood_extent(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    if not here["ok"]:
        return {"accepted": False, "reason": f"That point {here['reason']}."}
    return {"accepted": True, "payload": {"lat": lat, "lon": lon, "depth_m": here["depth_m"]}}


def evacuation_zone_stats(lat, lon, radius_m, ctx):
    """Ports computeEvacuationZoneStats."""
    stats = {"radius_m": radius_m, "max_depth_m": 0.0, "flooded_percent": 0, "building_count": 0, "hospitals": [], "critical": False}
    if not radius_m or radius_m <= 0:
        return stats

    scan = scan_depth_near(lat, lon, radius_m, ctx["depth_grid"], ctx["depth_meta"])
    stats["max_depth_m"] = scan["max_depth_m"]
    stats["flooded_percent"] = round((scan["wet_cells"] / scan["data_cells"]) * 100) if scan["data_cells"] > 0 else 0
    stats["building_count"] = count_buildings_within(lat, lon, radius_m, ctx["buildings_geojson"])

    facilities = ctx["facilities_geojson"]
    if facilities and facilities.get("features"):
        for feature in facilities["features"]:
            props = feature.get("properties") or {}
            if props.get("amenity") not in EVAC_HOSPITAL_AMENITIES:
                continue
            c = _feature_centroid(feature)
            if c is None:
                continue
            if distance_m(lon, lat, c[0], c[1]) <= radius_m:
                stats["hospitals"].append(props.get("name") or ("Unnamed " + str(props.get("amenity"))))

    stats["critical"] = len(stats["hospitals"]) > 0
    return stats


def validate_close_road(lat, lon, ctx):
    road = nearest_road(lat, lon, RULES["ROAD_SNAP_MAX_M"], ctx["roads_geojson"])
    if road["data_missing"]:
        return {"accepted": False, "reason": "Road data has not loaded — can't confirm a road is there."}
    if not road["found"]:
        return {"accepted": False, "reason": f"That click is {round(road['distance_m'])}m from the nearest road — click directly on the road you want to close."}

    flood = point_in_flood_extent(road["lat"], road["lon"], ctx["depth_grid"], ctx["depth_meta"])
    if not flood["ok"]:
        return {"accepted": False, "reason": f"That road {flood['reason']}."}
    if not flood["in_flood"]:
        return {"accepted": False, "reason": f"{_road_description(road)} is not in the current flood extent — there is nothing to close here."}
    if flood["depth_m"] < RULES["IMPASSABLE_ROAD_DEPTH_M"]:
        return {
            "accepted": False,
            "reason": f"Water on {_road_description(road)} is only {flood['depth_m']:.1f}m deep — under the "
                      f"{RULES['IMPASSABLE_ROAD_DEPTH_M']}m impassable threshold, so it is still driveable. Closing it would divert traffic for nothing.",
        }
    if _same_type_overlap(road["lat"], road["lon"], ctx.get("existing_closed_roads"), RULES["SAME_TYPE_OVERLAP_M"]):
        return {"accepted": False, "reason": f"{_road_description(road)} is already closed in this plan at that point."}

    return {
        "accepted": True,
        "payload": {
            "lat": road["lat"], "lon": road["lon"],
            "road_name": road["name"], "road_highway_type": road["highway_type"],
            "road_distance_m": road["distance_m"], "road_u": road["u"], "road_v": road["v"],
            "depth_m": flood["depth_m"],
        },
    }


def validate_boat_launch(lat, lon, ctx):
    here = point_in_flood_extent(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    if not here["ok"]:
        return {"accepted": False, "reason": f"That point {here['reason']}."}

    scan = scan_depth_near(lat, lon, RULES["BOAT_WATER_ADJACENCY_M"], ctx["depth_grid"], ctx["depth_meta"])
    has_water = here["in_flood"] or scan["wet_cells"] > 0
    road = nearest_road(lat, lon, RULES["BOAT_ROAD_ACCESS_MAX_M"], ctx["roads_geojson"])

    if not has_water:
        return {
            "accepted": False,
            "reason": f"That point is dry — no floodwater within {RULES['BOAT_WATER_ADJACENCY_M']}m. A launch point has to touch the water.",
        }
    if road["data_missing"]:
        return {"accepted": False, "reason": "Road data has not loaded — can't confirm trailer access."}
    if not road["found"]:
        return {
            "accepted": False,
            "reason": f"There is water here but the nearest road is {round(road['distance_m'])}m away — a boat trailer "
                      f"can't reach it. The limit is {RULES['BOAT_ROAD_ACCESS_MAX_M']}m.",
        }

    return {
        "accepted": True,
        "payload": {
            "lat": lat, "lon": lon,
            "depth_m": here["depth_m"],
            "max_depth_nearby_m": scan["max_depth_m"],
            "at_water_edge": not here["in_flood"],
            "water_distance_m": 0 if here["in_flood"] else scan["nearest_wet_m"],
            "road_name": road["name"], "road_highway_type": road["highway_type"], "road_distance_m": road["distance_m"],
        },
    }


def validate_relief_medical_post(lat, lon, ctx):
    zones = ctx.get("existing_evac_zones") or []
    if not zones:
        return {"accepted": False, "reason": "Add a priority evacuation zone first — this action exists to serve one."}
    nearest_zone_m = min(distance_m(lon, lat, z["lon"], z["lat"]) for z in zones)
    if nearest_zone_m > RULES["EVAC_ZONE_EXISTS_MAX_M"]:
        return {
            "accepted": False,
            "reason": f"The nearest evacuation zone is {round(nearest_zone_m)}m away — too far to serve it "
                      f"(needs to be within {RULES['EVAC_ZONE_EXISTS_MAX_M']}m).",
        }

    ground = point_on_safe_ground(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
    if not ground["ok"]:
        return {"accepted": False, "reason": f"That point {ground['reason']}."}
    if not ground["safe"]:
        return {"accepted": False, "reason": f"That point {ground['reason']}. A relief/medical point has to be on ground the water cannot reach — pick a spot further from the blue area."}

    road = nearest_road(lat, lon, RULES["ROAD_SNAP_MAX_M"], ctx["roads_geojson"])
    if road["data_missing"]:
        return {"accepted": False, "reason": "Road data has not loaded."}
    if not road["found"]:
        return {"accepted": False, "reason": f"No road within {RULES['ROAD_SNAP_MAX_M']}m — this must sit on an open road."}
    if _same_type_overlap(road["lat"], road["lon"], ctx.get("existing_closed_roads"), RULES["SAME_TYPE_OVERLAP_M"]):
        return {"accepted": False, "reason": f"{_road_description(road)} is closed in this plan — needs to be on an open road."}

    # Snap onto a real school/shelter if one is close AND itself safe --
    # never pulls the point toward water.
    snapped = None
    candidate = nearest_facility(lat, lon, SHELTER_AMENITIES, ctx["facilities_geojson"], RULES["SHELTER_SNAP_MAX_M"])
    if candidate["found"]:
        candidate_ground = point_on_safe_ground(candidate["lat"], candidate["lon"], ctx["depth_grid"], ctx["depth_meta"])
        if candidate_ground["ok"] and candidate_ground["safe"]:
            snapped = candidate

    site_lat, site_lon = (snapped["lat"], snapped["lon"]) if snapped else (lat, lon)
    site_ground = point_on_safe_ground(site_lat, site_lon, ctx["depth_grid"], ctx["depth_meta"]) if snapped else ground

    hospital = nearest_facility(lat, lon, EVAC_HOSPITAL_AMENITIES, ctx["facilities_geojson"])

    return {
        "accepted": True,
        "payload": {
            "lat": site_lat, "lon": site_lon,
            "nearest_zone_m": nearest_zone_m,
            "nearest_flood_m": site_ground["nearest_flood_m"],
            "road_name": road["name"], "road_highway_type": road["highway_type"], "road_distance_m": road["distance_m"],
            "snapped_facility_name": _facility_description(snapped) if snapped else None,
            "snap_distance_m": snapped["distance_m"] if snapped else None,
            "nearest_hospital_name": _facility_description(hospital) if hospital["distance_m"] is not None else None,
            "nearest_hospital_m": hospital["distance_m"],
        },
    }


VALIDATORS = {
    "warningPoint": validate_warning_point,
    "evacuationZone": validate_evacuation_zone,
    "closeRoad": validate_close_road,
    "boatLaunch": validate_boat_launch,
    "reliefMedicalPost": validate_relief_medical_post,
}


def build_context(water_level_m, roads_geojson, existing_plan_actions=None):
    """Assembles the shared ctx dict every validator above reads, from
    real backend data sources -- the same sources /flood-depth-grid,
    prevention_validation.load_roads_geojson, and the AI Hazard Analyst
    already use, so this agrees with the rest of the app by construction."""
    depth_grid, depth_meta = flood_engine.compute_depth_grid(water_level_m)
    existing_plan_actions = existing_plan_actions or []
    return {
        "depth_grid": depth_grid,
        "depth_meta": depth_meta,
        "roads_geojson": roads_geojson,
        "facilities_geojson": flood_engine.load_facilities(),
        "buildings_geojson": load_buildings_geojson(),
        "existing_closed_roads": [a for a in existing_plan_actions if a.get("type") == "closeRoad"],
        "existing_evac_zones": [a for a in existing_plan_actions if a.get("type") == "evacuationZone"],
    }
