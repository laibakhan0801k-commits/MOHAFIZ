"""
Response-side multi-agent AI comparison -- real candidate point
enumeration for Agent 2 (Strategist), mirroring ai_candidates.py's rule
for the Prevention Proposer: the LLM never invents a lat/lon, it only
ever picks from a real, finite, pre-generated list of candidate points
by id.

Each response action type is anchored to whichever real feature a human
placing it would actually use:
  - warningPoint / reliefMedicalPost -- real mapped facilities (mosques,
    schools, community centres...) within the zone, since both
    resolvers snap onto one anyway if it's close enough and safe.
  - closeRoad / boatLaunch -- real road segments within the zone,
    sampled every spacing_m, filtered to ones genuinely near/in the
    flood (skipping dry roads a human would never click for either).
  - evacuationZone -- has no snap target; the real anchor is the flood
    itself, so candidates are a coarse grid filtered to wet cells.
"""
import math

from response_validation import (
    WARNING_SNAP_AMENITIES, SHELTER_AMENITIES, RULES,
    depth_at_point, nearest_road, _feature_centroid,
)
from prevention_validation import distance_m


def _point_in_bbox(lon, lat, bbox):
    w, s, e, n = bbox
    return w <= lon <= e and s <= lat <= n


def _facility_candidates(amenity_types, zone_bbox, facilities_geojson):
    candidates = []
    cid = 0
    for feature in (facilities_geojson or {}).get("features", []):
        props = feature.get("properties") or {}
        if props.get("amenity") not in amenity_types:
            continue
        c = _feature_centroid(feature)
        if c is None or not _point_in_bbox(c[0], c[1], zone_bbox):
            continue
        candidates.append({
            "id": cid, "lon": c[0], "lat": c[1],
            "descriptor": f"{props.get('name') or 'Unnamed ' + str(props.get('amenity'))} ({props.get('amenity')})",
        })
        cid += 1
    return candidates


def _road_candidates(zone_bbox, roads_geojson, ctx, spacing_m, require_wet, wet_search_m):
    """Real points sampled every spacing_m along roads inside the zone.
    require_wet keeps only points genuinely near real floodwater (using
    the same depth grid the validators read), at wet_search_m distance
    -- e.g. ON the road for closeRoad, or within boat-launch adjacency
    for boatLaunch."""
    from prevention_validation import line_length_m, interpolate_line_m
    from response_validation import scan_depth_near

    candidates = []
    cid = 0
    for feature in roads_geojson.get("features", []):
        geom = feature.get("geometry")
        if not geom or geom["type"] != "LineString":
            continue
        coords = geom["coordinates"]
        length_m = line_length_m(coords)
        if length_m <= 0:
            continue
        num_points = max(1, round(length_m / spacing_m))
        props = feature.get("properties") or {}
        name = props.get("name") or "Unnamed road"
        for i in range(num_points + 1):
            target_m = (i / num_points) * length_m
            lon, lat = interpolate_line_m(coords, target_m)
            if not _point_in_bbox(lon, lat, zone_bbox):
                continue
            if require_wet:
                depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
                is_wet = depth is not None and depth > 0
                if not is_wet and wet_search_m > 0:
                    scan = scan_depth_near(lat, lon, wet_search_m, ctx["depth_grid"], ctx["depth_meta"])
                    is_wet = scan["wet_cells"] > 0
                if not is_wet:
                    continue
            candidates.append({
                "id": cid, "lon": lon, "lat": lat,
                "descriptor": f"On {name}, {round(target_m)}m along this segment",
            })
            cid += 1
    return candidates


def _wet_grid_candidates(zone_bbox, ctx, spacing_m=100):
    w, s, e, n = zone_bbox
    lat_mid = (s + n) / 2
    m_per_deg_lon = 111320 * math.cos(math.radians(lat_mid))
    step_lat = spacing_m / 111320
    step_lon = spacing_m / max(m_per_deg_lon, 1e-6)

    candidates = []
    cid = 0
    lat = s + step_lat / 2
    while lat <= n:
        lon = w + step_lon / 2
        while lon <= e:
            depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
            if depth is not None and depth > 0:
                candidates.append({
                    "id": cid, "lon": lon, "lat": lat,
                    "descriptor": f"Flooded point, {depth:.1f}m deep",
                })
                cid += 1
            lon += step_lon
        lat += step_lat
    return candidates


def generate_candidates(action_type, zone_bbox, ctx):
    """Returns a list of {id, lon, lat, descriptor} real candidate
    points for one action type within one hazard zone's bbox."""
    if action_type == "warningPoint":
        return _facility_candidates(WARNING_SNAP_AMENITIES, zone_bbox, ctx["facilities_geojson"])
    if action_type == "reliefMedicalPost":
        return _facility_candidates(SHELTER_AMENITIES, zone_bbox, ctx["facilities_geojson"])
    if action_type == "closeRoad":
        return _road_candidates(zone_bbox, ctx["roads_geojson"], ctx, spacing_m=30, require_wet=True, wet_search_m=0)
    if action_type == "boatLaunch":
        return _road_candidates(zone_bbox, ctx["roads_geojson"], ctx, spacing_m=30, require_wet=True,
                                 wet_search_m=RULES["BOAT_WATER_ADJACENCY_M"])
    if action_type == "evacuationZone":
        return _wet_grid_candidates(zone_bbox, ctx, spacing_m=100)
    return []


def filter_out_overlapping(candidates, existing_response_actions, min_gap_m=30):
    """Drops candidates within min_gap_m of an action already in the
    user's plan, so the AI can't propose a near-duplicate of something
    placed by hand."""
    if not existing_response_actions:
        return candidates
    existing_points = [(a["lon"], a["lat"]) for a in existing_response_actions if a.get("lon") is not None and a.get("lat") is not None]
    if not existing_points:
        return candidates
    return [
        c for c in candidates
        if not any(distance_m(c["lon"], c["lat"], elon, elat) < min_gap_m for elon, elat in existing_points)
    ]
