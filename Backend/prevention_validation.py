"""
PREVENTION ACTION VALIDATION -- Python port of PlanWorkspace.js's
validatePlacement() / checkPointConstraints() / validateEmbankmentLine() /
buildEmbankmentLine() / findNearestWaterwaySegment() / pointToFeatureDistance().

Same check order as the JS version (buildings/roads first -- physically
impossible -- then the waterway distance band, then the cross-field
checks), same real thresholds (prevention_constants.py), same real
citations behind the numbers. This is what makes an AI-proposed action
trustworthy: it is checked against the EXACT SAME rules a human clicking
the map would be checked against, not a second LLM's opinion.

Uses shapely (turf.js's Python equivalent) with an equirectangular local
projection for distance measurement -- the same flat-earth approximation
flood_engine.py's own terrain-modification functions already use, valid
at this corridor's small scale.
"""
import json
import math
from shapely.geometry import Point, LineString, shape
from shapely.ops import transform

import prevention_constants as C

M_PER_DEG_LAT = 111320.0


def _m_per_deg_lon(lat):
    return 111320.0 * math.cos(math.radians(lat))


_roads_geojson_cache = None


def load_roads_geojson():
    """The backend has no roads.geojson of its own -- flood_engine/
    road_flooding read roads.graphml (an osmnx graph) instead. Every
    check in this file expects LineString-feature GeoJSON (same shape
    waterways.geojson/buildings.geojson already are), so this converts
    the graph's edges into that shape once, using the exact same
    coords-extraction logic road_flooding.get_flooded_roads() already
    uses. Deliberately does NOT reach across into
    Frontend/mohafizweb/public/data/roads.geojson -- that is a
    separately-exported copy for the map UI, not this backend's data."""
    global _roads_geojson_cache
    if _roads_geojson_cache is not None:
        return _roads_geojson_cache

    import road_flooding
    G = road_flooding.load_roads()
    features = []
    for u, v, data in G.edges(data=True):
        if "geometry" in data:
            coords = [[pt[0], pt[1]] for pt in data["geometry"].coords]
        else:
            coords = [
                [G.nodes[u]["x"], G.nodes[u]["y"]],
                [G.nodes[v]["x"], G.nodes[v]["y"]],
            ]
        if len(coords) < 2:
            continue
        features.append({
            "type": "Feature",
            "properties": {"u": int(u), "v": int(v)},
            "geometry": {"type": "LineString", "coordinates": coords},
        })
    _roads_geojson_cache = {"type": "FeatureCollection", "features": features}
    return _roads_geojson_cache


_water_bodies_cache = None


def load_water_bodies_geojson():
    """water_bodies.geojson exists as a real file in Backend/ but
    flood_engine.py has no loader for it (only the frontend reads it
    today, for the retentionPond checkExistingWater check on the map
    UI) -- this is the backend-side equivalent, same lazy-cache-on-
    first-call pattern as flood_engine.load_waterways()/load_buildings()."""
    global _water_bodies_cache
    if _water_bodies_cache is None:
        with open("water_bodies.geojson", encoding="utf-8") as f:
            _water_bodies_cache = json.load(f)
    return _water_bodies_cache


def _project_local(geom, ref_lat):
    """Projects any shapely geometry's (lon,lat) coordinates to local
    approximate meters, centered at ref_lat for the longitude scale
    factor, so shapely's native .distance()/.contains() are real-world
    metre-accurate at this corridor's scale."""
    scale_lon = _m_per_deg_lon(ref_lat)
    return transform(lambda x, y, z=None: (x * scale_lon, y * M_PER_DEG_LAT), geom)


def distance_m(lon1, lat1, lon2, lat2):
    lat_mid = (lat1 + lat2) / 2
    dx = (lon2 - lon1) * _m_per_deg_lon(lat_mid)
    dy = (lat2 - lat1) * M_PER_DEG_LAT
    return math.sqrt(dx * dx + dy * dy)


def _feature_distance_m(point, feature):
    """Real distance in meters from a shapely Point to one GeoJSON
    feature's geometry (Point/LineString/MultiLineString/Polygon/
    MultiPolygon) -- polygon distance is to its BOUNDARY (a point
    inside is distance 0), matching pointToFeatureDistance's use of
    turf.polygonToLine."""
    geom = feature.get("geometry")
    if not geom:
        return float("inf")
    shapely_geom = shape(geom)
    if geom["type"] in ("Polygon", "MultiPolygon"):
        shapely_geom = shapely_geom.boundary
    p_local = _project_local(point, point.y)
    g_local = _project_local(shapely_geom, point.y)
    return p_local.distance(g_local)


# Public alias matching the JS function name this ports.
point_to_feature_distance_m = _feature_distance_m


def nearest_line_distance_m(point, lines_geojson):
    """Nearest distance in meters from `point` to any LineString/
    MultiLineString feature in a FeatureCollection -- mirrors
    turf.nearestPointOnLine run against a whole waterways/roads
    FeatureCollection."""
    best_m = None
    for feature in lines_geojson.get("features", []):
        geom = feature.get("geometry")
        if not geom or geom["type"] not in ("LineString", "MultiLineString"):
            continue
        d = _feature_distance_m(point, feature)
        if best_m is None or d < best_m:
            best_m = d
    return best_m


def check_point_constraints(lon, lat, config, waterways_geojson, buildings_geojson,
                             roads_geojson, water_bodies_geojson=None):
    """Python port of validatePlacement() in PlanWorkspace.js -- the
    generalized, config-driven single source of truth every real
    prevention action's placement check calls. Same check order:
      1. buildings (physically impossible)
      2. roads (physically impossible / config-gated)
      3. waterway distance band (not impossible, just not useful)
      4. existing-water-body cross-check (retention pond)
      5. "room to widen" building-proximity cross-check (widen channel)

    Returns (ok: bool, reason: str | None, extra: dict). `extra` carries
    e.g. 'clicked_building' for removeEncroachment, matching the JS
    version's { ok, clickedBuilding } shape.
    """
    point = Point(lon, lat)
    extra = {}

    # 1. Building checks
    if buildings_geojson and buildings_geojson.get("features"):
        found_building_hit = False
        for feature in buildings_geojson["features"]:
            geom = feature.get("geometry")
            if not geom:
                continue
            gtype = geom["type"]

            if gtype == "Point" and config.get("buildingClearance"):
                blon, blat = geom["coordinates"]
                distance = distance_m(lon, lat, blon, blat)
                if distance < config["buildingClearance"]:
                    return False, f"is only {round(distance)}m from a building", extra

            elif gtype in ("Polygon", "MultiPolygon"):
                poly = shape(geom)
                if poly.contains(point):
                    found_building_hit = True
                    if config.get("requireOnBuilding"):
                        amenity = (feature.get("properties") or {}).get("amenity")
                        exclude = config.get("excludeAmenities") or []
                        if amenity and amenity in exclude:
                            return False, f"is a {amenity} — can't flag essential infrastructure as encroachment", extra
                        extra["clicked_building"] = feature
                        return True, None, extra
                    else:
                        return False, "falls inside a building footprint", extra

        if config.get("requireOnBuilding") and not found_building_hit:
            return False, "doesn't land on a building — click directly on a structure", extra

    # 2. Road checks
    road_clearance = config.get("roadClearance", 0)
    if roads_geojson and roads_geojson.get("features") and road_clearance > 0:
        nearest_road_m = nearest_line_distance_m(point, roads_geojson)
        if nearest_road_m is not None and nearest_road_m < road_clearance:
            return False, f"is only {round(nearest_road_m)}m from a road", extra

    # 3. Waterway distance band
    min_wd = config.get("minWaterwayDistance")
    max_wd = config.get("maxWaterwayDistance")
    if min_wd is not None or max_wd is not None:
        if not waterways_geojson or not waterways_geojson.get("features"):
            return False, "can't be checked against the nullah (data not loaded yet)", extra
        waterway_distance_m = nearest_line_distance_m(point, waterways_geojson)
        if waterway_distance_m is None:
            return False, "can't be checked against the nullah (data not loaded yet)", extra
        if min_wd and min_wd > 0 and waterway_distance_m < min_wd:
            return False, f"is only {round(waterway_distance_m)}m from the nullah — inside the channel itself", extra
        if max_wd and max_wd > 0 and waterway_distance_m > max_wd:
            return False, f"is {round(waterway_distance_m)}m from the nearest nullah — too far", extra

    # 4. Existing water body check (retention pond)
    if config.get("checkExistingWater") and water_bodies_geojson and water_bodies_geojson.get("features"):
        for feature in water_bodies_geojson["features"]:
            geom = feature.get("geometry")
            if not geom or geom["type"] not in ("Polygon", "MultiPolygon"):
                continue
            if shape(geom).contains(point):
                return False, "is already on an existing water body — no need to build a pond here", extra

    # 5. Building proximity check (widen channel -- is there room?)
    require_no_building_nearby = config.get("requireNoBuildingNearby")
    if require_no_building_nearby and buildings_geojson and buildings_geojson.get("features"):
        for feature in buildings_geojson["features"]:
            geom = feature.get("geometry")
            if not geom:
                continue
            gtype = geom["type"]
            if gtype == "Point":
                blon, blat = geom["coordinates"]
                distance = distance_m(lon, lat, blon, blat)
                if distance < require_no_building_nearby:
                    return False, f"has a building only {round(distance)}m away — no room to widen without demolition", extra
            elif gtype in ("Polygon", "MultiPolygon"):
                min_dist = _feature_distance_m(point, feature)
                if min_dist < require_no_building_nearby:
                    return False, f"has a building only {round(min_dist)}m away — no room to widen without demolition", extra

    return True, None, extra


def check_point_constraints_embankment(lon, lat, waterways_geojson, buildings_geojson, roads_geojson):
    """Python port of checkPointConstraints() -- the embankment-specific
    wrapper. Always hardcodes EMBANKMENT_* constants (never reads
    embankment's own ACTION_VALIDATION_CONFIG entry) -- mirroring the
    real JS legacy behaviour exactly, not "fixing" it."""
    config = {
        "minWaterwayDistance": C.EMBANKMENT_MIN_DISTANCE_M,
        "maxWaterwayDistance": C.EMBANKMENT_MAX_DISTANCE_M,
        "roadClearance": C.EMBANKMENT_ROAD_BUFFER_M,
        "buildingClearance": C.EMBANKMENT_BUILDING_CLEARANCE_M,
    }
    ok, reason, _ = check_point_constraints(lon, lat, config, waterways_geojson, buildings_geojson, roads_geojson)
    return ok, reason


def find_nearest_waterway_segment(lon, lat, waterways_geojson, max_distance_m):
    """Python port of findNearestWaterwaySegment() -- the waterway-snap
    check used for desilt/clearDrains/warningGauge."""
    if not waterways_geojson or not waterways_geojson.get("features"):
        return {"accepted": False, "reason": "Waterway data not loaded yet — try again in a moment."}

    point = Point(lon, lat)
    best = None
    for feature in waterways_geojson["features"]:
        geom = feature.get("geometry")
        if not geom or geom["type"] != "LineString":
            continue
        line = LineString(geom["coordinates"])
        p_local = _project_local(point, lat)
        line_local = _project_local(line, lat)
        d = p_local.distance(line_local)
        # Map the local nearest point back to real lon/lat via the same
        # fraction-along-the-line (projection is locally linear here).
        frac = line_local.project(p_local, normalized=True)
        real_nearest = line.interpolate(frac, normalized=True)
        if best is None or d < best["distance_m"]:
            best = {"distance_m": d, "lon": real_nearest.x, "lat": real_nearest.y, "feature": feature}

    if best is None:
        return {"accepted": False, "reason": "Waterway data not loaded yet — try again in a moment."}

    if best["distance_m"] > max_distance_m:
        return {
            "accepted": False,
            "reason": f"That point is {round(best['distance_m'])}m from the nearest nullah — click closer to the blue line.",
            "distance_m": best["distance_m"],
        }

    props = best["feature"].get("properties") or {}
    return {
        "accepted": True,
        "distance_m": best["distance_m"],
        "lon": best["lon"],
        "lat": best["lat"],
        "segment_name": props.get("name") or "Unnamed waterway section",
        "waterway_id": props.get("id"),
    }


def line_length_m(coords):
    total = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        total += distance_m(lon1, lat1, lon2, lat2)
    return total


def interpolate_line_m(coords, target_m):
    """Point at `target_m` meters along a real (lon,lat) polyline,
    linearly interpolating within whichever segment contains it --
    matches turf.along()'s behaviour closely enough at this scale."""
    remaining = target_m
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        seg_m = distance_m(lon1, lat1, lon2, lat2)
        if seg_m == 0:
            continue
        if remaining <= seg_m:
            frac = remaining / seg_m
            return (lon1 + (lon2 - lon1) * frac, lat1 + (lat2 - lat1) * frac)
        remaining -= seg_m
    return tuple(coords[-1])


def _destination(lon, lat, distance_m, bearing_rad):
    """Point distance_m away from (lon,lat) at bearing_rad (0 = north,
    clockwise positive) -- same flat approximation as the rest of this
    file, equivalent to turf.destination at this corridor's scale."""
    dlat = (distance_m * math.cos(bearing_rad)) / M_PER_DEG_LAT
    dlon = (distance_m * math.sin(bearing_rad)) / _m_per_deg_lon(lat)
    return (lon + dlon, lat + dlat)


def build_embankment_line(anchor_lon, anchor_lat, length_m, waterways_geojson):
    """Python port of buildEmbankmentLine() -- orients the wall PARALLEL
    to the nearest real waterway segment at this point (how a real levee
    is actually built), extending length_m/2 in each direction from the
    anchor (which becomes the line's midpoint). Returns
    [[lon,lat],[lon,lat]] or None on failure."""
    if not waterways_geojson or not waterways_geojson.get("features"):
        return None

    anchor = Point(anchor_lon, anchor_lat)
    a_local = _project_local(anchor, anchor_lat)

    best_feature = None
    best_d = None
    for feature in waterways_geojson["features"]:
        geom = feature.get("geometry")
        if not geom or geom["type"] != "LineString":
            continue
        line_local = _project_local(LineString(geom["coordinates"]), anchor_lat)
        d = a_local.distance(line_local)
        if best_d is None or d < best_d:
            best_d = d
            best_feature = feature

    if best_feature is None:
        return None

    coords = best_feature["geometry"]["coordinates"]
    if len(coords) < 2:
        return None

    # Find which segment of that feature the anchor is nearest to, so
    # the wall's bearing matches the LOCAL channel direction, not just
    # the feature's overall start-to-end direction.
    best_seg_idx = 0
    best_seg_d = None
    for i in range(len(coords) - 1):
        seg_local = _project_local(LineString([coords[i], coords[i + 1]]), anchor_lat)
        d = a_local.distance(seg_local)
        if best_seg_d is None or d < best_seg_d:
            best_seg_d = d
            best_seg_idx = i

    seg_start = coords[best_seg_idx]
    seg_end = coords[best_seg_idx + 1]
    if seg_start[0] == seg_end[0] and seg_start[1] == seg_end[1]:
        seg_start, seg_end = coords[0], coords[-1]
        if seg_start[0] == seg_end[0] and seg_start[1] == seg_end[1]:
            return None  # degenerate line, can't determine a direction

    lat_mid = (seg_start[1] + seg_end[1]) / 2
    bearing = math.atan2(
        (seg_end[0] - seg_start[0]) * _m_per_deg_lon(lat_mid),
        (seg_end[1] - seg_start[1]) * M_PER_DEG_LAT,
    )

    half_m = length_m / 2
    end_a = _destination(anchor_lon, anchor_lat, half_m, bearing)
    end_b = _destination(anchor_lon, anchor_lat, half_m, bearing + math.pi)
    return [list(end_a), list(end_b)]


def validate_embankment_line(line_coords, waterways_geojson, buildings_geojson, roads_geojson):
    """Python port of validateEmbankmentLine() -- samples every
    EMBANKMENT_SAMPLE_INTERVAL_M along the proposed wall, not just the
    anchor, same as the JS version."""
    total_length_m = line_length_m(line_coords)
    num_samples = max(2, math.ceil(total_length_m / C.EMBANKMENT_SAMPLE_INTERVAL_M))

    for i in range(num_samples + 1):
        target_m = (i / num_samples) * total_length_m
        sample_lon, sample_lat = interpolate_line_m(line_coords, target_m)
        ok, reason = check_point_constraints_embankment(sample_lon, sample_lat, waterways_geojson, buildings_geojson, roads_geojson)
        if not ok:
            position_m = round(target_m)
            return False, f"At {position_m}m along the wall: {reason}. Try a shorter length or different location."

    return True, None
