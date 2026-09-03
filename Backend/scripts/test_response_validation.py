"""
Standalone test for response_validation.py -- Part 0 of the Response-side
multi-agent AI comparison. Runs each of the 5 real river_overflow action
validators against real coordinates from this corridor's own data (real
DEM, real roads.geojson, real facilities.geojson, real buildings.geojson),
at a real water level, and prints the actual accept/reject output --
same discipline as test_prevention_validation.py.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

import json
import flood_engine
import prevention_validation as PV
import response_validation as RV

WATER_LEVEL_M = 522


def load_geojson(name):
    with open(name, encoding="utf-8") as f:
        return json.load(f)


def main():
    print(f"Building real context at water_level_m={WATER_LEVEL_M}...")
    roads = PV.load_roads_geojson()
    ctx = RV.build_context(WATER_LEVEL_M, roads, existing_plan_actions=[])
    print(f"  depth grid: {ctx['depth_meta']['width']}x{ctx['depth_meta']['height']}, "
          f"{len(roads['features'])} roads, {len(ctx['facilities_geojson']['features'])} facilities, "
          f"{len(ctx['buildings_geojson']['features'])} buildings\n")

    # Find a real wet cell and a real dry cell to test against, by
    # scanning the actual depth grid -- not guessed/hardcoded coordinates.
    depth_grid, meta = ctx["depth_grid"], ctx["depth_meta"]
    west, south, east, north = meta["bounds"]
    height, width = depth_grid.shape

    # Find a real flooded road (a wet cell genuinely close to a real road,
    # by re-using nearest_road itself) so the close_road/boat_launch
    # accept paths get real exercise, not just their rejections.
    wet_point = None
    for r in range(0, height, 2):
        for c in range(0, width, 2):
            d = depth_grid[r, c]
            if d != d or d <= RV.RULES["IMPASSABLE_ROAD_DEPTH_M"]:
                continue
            lat = north - (r + 0.5) * (north - south) / height
            lon = west + (c + 0.5) * (east - west) / width
            road = RV.nearest_road(lat, lon, RV.RULES["ROAD_SNAP_MAX_M"], roads)
            if road["found"]:
                wet_point = (lat, lon, float(d))
                break
        if wet_point:
            break

    # A dry point genuinely near that wet point, for the relief/medical
    # post's "must be within EVAC_ZONE_EXISTS_MAX_M of a real zone" check.
    dry_point = None
    for r in range(0, height, 2):
        for c in range(0, width, 2):
            d = depth_grid[r, c]
            lat = north - (r + 0.5) * (north - south) / height
            lon = west + (c + 0.5) * (east - west) / width
            if d == 0 and PV.distance_m(wet_point[1], wet_point[0], lon, lat) < 1500:
                dry_point = (lat, lon)
                break
        if dry_point:
            break

    print(f"Real wet point found (near a real road): {wet_point}")
    print(f"Real dry point found (near that wet point): {dry_point}\n")

    print("=" * 70)
    print("TEST 1: validate_warning_point at the wet point (should accept)")
    print("=" * 70)
    r1 = RV.validate_warning_point(wet_point[0], wet_point[1], ctx)
    print(r1)
    assert r1["accepted"] is True, "Expected acceptance in the flood extent"

    print("\n" + "=" * 70)
    print("TEST 2: validate_evacuation_zone at the wet point + real stats")
    print("=" * 70)
    r2 = RV.validate_evacuation_zone(wet_point[0], wet_point[1], ctx)
    print(r2)
    assert r2["accepted"] is True
    stats = RV.evacuation_zone_stats(wet_point[0], wet_point[1], 300, ctx)
    print("evacuation_zone_stats(radius=300m):", stats)

    print("\n" + "=" * 70)
    print("TEST 3: validate_close_road at the wet point (finds nearest road)")
    print("=" * 70)
    r3 = RV.validate_close_road(wet_point[0], wet_point[1], ctx)
    print(r3)

    print("\n" + "=" * 70)
    print("TEST 4: validate_close_road AGAIN at the same spot with it in")
    print("        existing_closed_roads (should reject as duplicate)")
    print("=" * 70)
    if r3["accepted"]:
        ctx_dup = dict(ctx)
        ctx_dup["existing_closed_roads"] = [{"lat": r3["payload"]["lat"], "lon": r3["payload"]["lon"]}]
        r4 = RV.validate_close_road(wet_point[0], wet_point[1], ctx_dup)
        print(r4)
        assert r4["accepted"] is False, "Expected duplicate-closure rejection"
    else:
        print("(skipped -- test 3 did not find/accept a real road to close here)")

    print("\n" + "=" * 70)
    print("TEST 5: validate_boat_launch at the wet point")
    print("=" * 70)
    r5 = RV.validate_boat_launch(wet_point[0], wet_point[1], ctx)
    print(r5)

    print("\n" + "=" * 70)
    print("TEST 6: validate_relief_medical_post with NO evac zone yet")
    print("        (should reject -- must serve an existing zone)")
    print("=" * 70)
    r6 = RV.validate_relief_medical_post(dry_point[0], dry_point[1], ctx)
    print(r6)
    assert r6["accepted"] is False
    assert "evacuation zone" in r6["reason"]

    print("\n" + "=" * 70)
    print("TEST 7: validate_relief_medical_post WITH a nearby evac zone")
    print("        at the dry point (should accept, on safe ground)")
    print("=" * 70)
    ctx_zone = dict(ctx)
    ctx_zone["existing_evac_zones"] = [{"lat": wet_point[0], "lon": wet_point[1]}]
    r7 = RV.validate_relief_medical_post(dry_point[0], dry_point[1], ctx_zone)
    print(r7)

    print("\n" + "=" * 70)
    print("ALL TESTS RAN. Every accept/reject above came from the real DEM,")
    print("real roads/facilities/buildings data, and the ported river_overflow")
    print("rules -- not fabricated.")
    print("=" * 70)


if __name__ == "__main__":
    main()
