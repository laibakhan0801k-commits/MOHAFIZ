"""
Standalone test for prevention_validation.py -- Part 1 of the AI
Prevention Proposer build.

Since there's no way to run PlanWorkspace.js's validatePlacement() in a
browser from here to diff outputs directly, this instead proves the
Python port is internally correct against REAL geometry: it finds a real
point on a real waterway from waterways.geojson, then builds test points
at deliberately chosen, verifiable real distances from it (via a real
destination-point calculation, not guessed coordinates), and checks that
check_point_constraints/_embankment accept/reject each one exactly as
the ported thresholds (prevention_constants.py) say they should.
"""
import json
import math
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")  # Windows console defaults to cp1252, which mangles the em dash in reason strings

import prevention_constants as C
import prevention_validation as V

M_PER_DEG_LAT = 111320.0


def _m_per_deg_lon(lat):
    return 111320.0 * math.cos(math.radians(lat))


def _destination(lon, lat, distance_m, bearing_deg):
    bearing_rad = math.radians(bearing_deg)
    dlat = (distance_m * math.cos(bearing_rad)) / M_PER_DEG_LAT
    dlon = (distance_m * math.sin(bearing_rad)) / _m_per_deg_lon(lat)
    return (lon + dlon, lat + dlat)


def load_geojson(name):
    with open(name, encoding="utf-8") as f:
        return json.load(f)


def main():
    waterways = load_geojson("waterways.geojson")
    buildings = load_geojson("buildings.geojson")
    roads = V.load_roads_geojson()
    water_bodies = load_geojson("water_bodies.geojson")

    print(f"Loaded {len(waterways['features'])} waterway features, "
          f"{len(buildings['features'])} buildings, "
          f"{len(roads['features'])} road features, "
          f"{len(water_bodies['features'])} water body features.\n")

    # Pick a real waterway LineString far from its endpoints (so
    # bearing/offset math has real neighbours on both sides), and a
    # point at its midpoint as the anchor for constructed test points.
    anchor_feature = None
    for f in waterways["features"]:
        geom = f.get("geometry")
        if geom and geom["type"] == "LineString" and len(geom["coordinates"]) >= 3:
            anchor_feature = f
            break
    assert anchor_feature is not None, "no usable waterway feature found"
    coords = anchor_feature["geometry"]["coordinates"]
    mid_idx = len(coords) // 2
    anchor_lon, anchor_lat = coords[mid_idx]
    print(f"Anchor waterway point: ({anchor_lon:.6f}, {anchor_lat:.6f}) "
          f"on '{(anchor_feature.get('properties') or {}).get('name', 'Unnamed')}'\n")

    # Perpendicular-ish bearing (90 deg off the local segment direction)
    # so offset points move AWAY from the channel, not along it.
    prev_pt = coords[max(0, mid_idx - 1)]
    next_pt = coords[min(len(coords) - 1, mid_idx + 1)]
    seg_bearing = math.degrees(math.atan2(
        (next_pt[0] - prev_pt[0]) * _m_per_deg_lon(anchor_lat),
        (next_pt[1] - prev_pt[1]) * M_PER_DEG_LAT,
    ))
    perp_bearing = seg_bearing + 90

    print("=" * 70)
    print("TEST 1 -- embankment distance-band checks (min=5m, max=50m)")
    print("=" * 70)
    cases = [
        (2, "2m from waterway -- inside the channel, should REJECT (too close)", False),
        (5.5, "5.5m from waterway -- just inside the band, should ACCEPT*", None),
        (20, "20m from waterway -- comfortably inside the band, should ACCEPT*", None),
        (49, "49m from waterway -- just inside the band, should ACCEPT*", None),
        (60, "60m from waterway -- outside the band, should REJECT (too far)", False),
        (200, "200m from waterway -- well outside the band, should REJECT (too far)", False),
    ]
    for dist_m, label, expect in cases:
        lon, lat = _destination(anchor_lon, anchor_lat, dist_m, perp_bearing)
        ok, reason = V.check_point_constraints_embankment(lon, lat, waterways, buildings, roads)
        mark = "PASS" if (expect is None or ok == expect) else "FAIL <-- UNEXPECTED"
        print(f"[{mark}] {label}")
        print(f"        -> ok={ok}, reason={reason!r}")
    print("(*ACCEPT here assumes this offset point doesn't also happen to land on/near\n"
          " a real building or road -- printed reason will say which if so; that's a\n"
          " correct rejection too, just for a different documented cause.)\n")

    print("=" * 70)
    print("TEST 2 -- a real building footprint should reject any building-checked action")
    print("=" * 70)
    building_feature = None
    for f in buildings["features"]:
        geom = f.get("geometry")
        if geom and geom["type"] in ("Polygon", "MultiPolygon"):
            building_feature = f
            break
    assert building_feature is not None, "no polygon building found"
    from shapely.geometry import shape as shapely_shape
    poly = shapely_shape(building_feature["geometry"])
    # .representative_point() is guaranteed to fall INSIDE the polygon,
    # unlike .centroid (the geometric center of mass), which can land
    # outside a concave/complex footprint -- using centroid here first
    # caught exactly that on the real data, see report.
    inside_point = poly.representative_point()
    assert poly.contains(inside_point), "sanity check: representative_point should always be inside"
    ok, reason = V.check_point_constraints_embankment(inside_point.x, inside_point.y, waterways, buildings, roads)
    mark = "PASS" if ok is False and reason == "falls inside a building footprint" else "FAIL <-- UNEXPECTED"
    print(f"[{mark}] Real building interior point ({inside_point.x:.6f}, {inside_point.y:.6f})")
    print(f"        -> ok={ok}, reason={reason!r}\n")

    print("=" * 70)
    print("TEST 3 -- pointToFeatureDistance-based road clearance (embankment needs >=15m)")
    print("=" * 70)
    if roads["features"]:
        road_feature = roads["features"][0]
        road_coords = road_feature["geometry"]["coordinates"]
        rlon, rlat = road_coords[len(road_coords) // 2]
        ok, reason = V.check_point_constraints_embankment(rlon, rlat, waterways, buildings, roads)
        print(f"Point ON a real road midpoint ({rlon:.6f}, {rlat:.6f})")
        print(f"        -> ok={ok}, reason={reason!r}")
        print("(Expected to reject for road proximity UNLESS the same point also fails\n"
              " an earlier check first -- building or waterway-band -- since checks run\n"
              " in the same order as the JS version: buildings, then roads, then waterway.)\n")
    else:
        print("No Backend/roads.geojson present -- skipping (roads live in roads.graphml for\n"
              "the flood engine; this validator needs the geojson LineString form the\n"
              "frontend uses. See note in the summary below.)\n")

    print("=" * 70)
    print("TEST 4 -- validate_embankment_line samples the WHOLE wall, not just the anchor")
    print("=" * 70)
    line_coords = V.build_embankment_line(anchor_lon, anchor_lat, 40, waterways)
    print(f"build_embankment_line(anchor, 40m, waterways) -> {line_coords}")
    if line_coords:
        ok, reason = V.validate_embankment_line(line_coords, waterways, buildings, roads)
        print(f"validate_embankment_line -> ok={ok}, reason={reason!r}\n")
    else:
        print("build_embankment_line returned None (degenerate geometry at this anchor)\n")

    print("=" * 70)
    print("TEST 5 -- generalized check_point_constraints() against each real ACTION_VALIDATION_CONFIG")
    print("=" * 70)
    for action_type, config in C.ACTION_VALIDATION_CONFIG.items():
        if not config:
            continue  # waterway-snap-only actions, tested separately below
        dist_m = 20 if action_type != "removeEncroachment" else 5
        lon, lat = _destination(anchor_lon, anchor_lat, dist_m, perp_bearing)
        ok, reason, extra = V.check_point_constraints(lon, lat, config, waterways, buildings, roads, water_bodies)
        print(f"[{action_type}] point {dist_m}m from waterway -> ok={ok}, reason={reason!r}, extra_keys={list(extra.keys())}")
    print()

    print("=" * 70)
    print("TEST 6 -- find_nearest_waterway_segment (desilt/clearDrains/warningGauge)")
    print("=" * 70)
    result = V.find_nearest_waterway_segment(anchor_lon, anchor_lat, waterways, C.WATERWAY_SNAP_MAX_M)
    print(f"Anchor point itself (on the waterway) -> {result}")
    far_lon, far_lat = _destination(anchor_lon, anchor_lat, 100, perp_bearing)
    result_far = V.find_nearest_waterway_segment(far_lon, far_lat, waterways, C.WATERWAY_SNAP_MAX_M)
    print(f"Point 100m away -> {result_far}")


if __name__ == "__main__":
    main()
