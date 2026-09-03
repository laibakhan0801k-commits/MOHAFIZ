"""
AI PREVENTION PROPOSER -- real candidate point enumeration.

The LLM never invents a lat/lon. It only ever picks from a real, finite,
pre-generated list of candidate points by id -- this file's job is
generating that list. Every candidate here sits on REAL geometry (a
sampled point along a real waterway feature, a real building's interior
point within the real encroachment distance band) -- never an
arbitrary coordinate the model could hallucinate its way around.
"""
from shapely.geometry import Point, shape

import prevention_constants as C
import prevention_validation as V

# Action types anchored to the waterway network -- candidates are real
# points sampled every `spacing_m` along each real waterway feature.
WATERWAY_ANCHORED_ACTIONS = (
    "embankment", "desilt", "clearDrains", "widenChannel",
    "warningGauge", "retentionPond", "greenBuffer",
)


def _point_in_bbox(lon, lat, bbox):
    w, s, e, n = bbox
    return w <= lon <= e and s <= lat <= n


def generate_candidate_points(action_type, priority_bbox, waterways_geojson,
                               buildings_geojson, spacing_m=30):
    """
    Enumerates REAL candidate points within a priority zone (bbox, from
    the Hazard Analyst) for the Proposer to choose from, by id.

    - Waterway-anchored actions (see WATERWAY_ANCHORED_ACTIONS): every
      `spacing_m` along each real waterway LineString feature that
      falls inside the bbox.
    - removeEncroachment: real building interior points inside the
      bbox, within the real ENCROACHMENT distance band
      (ACTION_VALIDATION_CONFIG['removeEncroachment']['maxWaterwayDistance']),
      excluding essential-amenity buildings -- same exclusion list the
      real click-validation config already uses.

    Returns a list of {id, lon, lat, descriptor, ...}. Never returns a
    lat/lon that isn't a real point taken from real input geometry.
    """
    candidates = []
    cid = 0

    if action_type in WATERWAY_ANCHORED_ACTIONS:
        for feature in waterways_geojson.get("features", []):
            geom = feature.get("geometry")
            if not geom or geom["type"] != "LineString":
                continue
            coords = geom["coordinates"]
            length_m = V.line_length_m(coords)
            if length_m <= 0:
                continue
            num_points = max(1, round(length_m / spacing_m))
            name = (feature.get("properties") or {}).get("name") or "Unnamed waterway"
            for i in range(num_points + 1):
                target_m = (i / num_points) * length_m
                lon, lat = V.interpolate_line_m(coords, target_m)
                if not _point_in_bbox(lon, lat, priority_bbox):
                    continue
                candidates.append({
                    "id": cid,
                    "lon": lon,
                    "lat": lat,
                    "waterway_name": name,
                    "descriptor": f"On {name}, {round(target_m)}m along this segment",
                })
                cid += 1

    elif action_type == "removeEncroachment":
        config = C.ACTION_VALIDATION_CONFIG["removeEncroachment"]
        excluded_amenities = set(config.get("excludeAmenities") or [])
        max_dist_m = config.get("maxWaterwayDistance")

        for feature in buildings_geojson.get("features", []):
            props = feature.get("properties") or {}
            if props.get("amenity") in excluded_amenities:
                continue
            geom = feature.get("geometry")
            if not geom:
                continue
            gtype = geom["type"]
            if gtype in ("Polygon", "MultiPolygon"):
                # representative_point(), not centroid -- centroid can
                # land OUTSIDE a concave building footprint (see the
                # real bug this caught in Part 1's standalone test).
                center = shape(geom).representative_point()
            elif gtype == "Point":
                center = Point(geom["coordinates"])
            else:
                continue

            if not _point_in_bbox(center.x, center.y, priority_bbox):
                continue

            dist_m = V.nearest_line_distance_m(center, waterways_geojson)
            if dist_m is None or dist_m > max_dist_m:
                continue

            candidates.append({
                "id": cid,
                "lon": center.x,
                "lat": center.y,
                "descriptor": f"Building ({props.get('building', 'unspecified')}), {round(dist_m)}m from nullah",
            })
            cid += 1

    return candidates


def filter_out_overlapping(candidates, existing_plan_actions, min_gap_m=None):
    """Drops candidates that sit within min_gap_m of an EXISTING placed
    action of any type, so the AI can't propose a duplicate of something
    the user already placed. `existing_plan_actions` items need
    lon/lat (or lng/lat) keys -- the same shape PreventionAction carries
    in main.py. Defaults min_gap_m to EMBANKMENT_SAMPLE_INTERVAL_M * 6 =
    30m, matching PlanWorkspace.js's own SAME_TYPE_OVERLAP-style spacing
    used elsewhere in this codebase for "too close to an existing
    action" checks."""
    if min_gap_m is None:
        min_gap_m = 30
    if not existing_plan_actions:
        return candidates

    existing_points = []
    for a in existing_plan_actions:
        lon = a.get("lon", a.get("lng"))
        lat = a.get("lat")
        if lon is not None and lat is not None:
            existing_points.append((lon, lat))

    if not existing_points:
        return candidates

    kept = []
    for c in candidates:
        too_close = any(
            V.distance_m(c["lon"], c["lat"], elon, elat) < min_gap_m
            for elon, elat in existing_points
        )
        if not too_close:
            kept.append(c)
    return kept
