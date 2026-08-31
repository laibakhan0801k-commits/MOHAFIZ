"""
Regression test: two prevention measures of the SAME type and SAME size,
placed at CLEARLY DIFFERENT locations, must produce different computed
impacts (their local protection zone covers different real ground, so
different roads/buildings/terrain fall inside it).

This does not assert every field differs — a measure's own storage
volume (volume_stored_m3) is legitimately a function of its SIZE only,
not its location, so two same-sized ponds correctly report identical
volume. What must differ is the location-DEPENDENT output: the flooded
pixels each one actually protects (area_saved_m2 / pixels_saved).

Run with: venv/Scripts/python.exe scripts/test_location_awareness.py
"""
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import flood_engine
from main import _run_prevention_sim


def _spread_flooded_points(elevation, bounds, water_level_m, n=3):
    """Real flooded DEM pixels spread across the flood's lon range, not
    clustered together — so a location-awareness test actually exercises
    different local terrain instead of two points 20m apart."""
    west, south, east, north = bounds
    H, W = elevation.shape
    flooded = elevation <= water_level_m
    rows, cols = np.where(flooded)
    if len(rows) < n:
        raise RuntimeError("Not enough flooded pixels for this test; pick a bigger scenario")
    lons = west + (cols + 0.5) / W * (east - west)
    lats = north - (rows + 0.5) / H * (north - south)
    order = np.argsort(lons)
    picks = [order[5], order[len(order) // 2], order[-5]]
    return [(float(lons[i]), float(lats[i])) for i in picks[:n]]


def main():
    elevation, valid = flood_engine.load_dem()
    bounds = flood_engine.get_dem_bounds()
    cause_type = "river_overflow"
    params = {"bank_rise_m": 0.55}
    water_level_m = 512.0

    points = _spread_flooded_points(elevation, bounds, water_level_m, n=3)
    print("Test points (lon, lat):", points)

    pond_params = {"surface_area_m2": 8000, "depth_m": 2.5}
    single_results = []
    for i, (lon, lat) in enumerate(points):
        action = {"uid": i + 1, "type": "retentionPond", "lat": lat, "lon": lon, "params": dict(pond_params)}
        before, after, _, _, _, _, _ = _run_prevention_sim(
            cause_type, params, [action], elevation, bounds, direct_water_level_m=water_level_m,
        )
        single_results.append({
            "point": (lon, lat),
            "flooded_percent": after["flooded_percent"],
            "pixels_saved": after["pixels_saved"],
            "area_saved_m2": after["area_saved_m2"],
            "volume_stored_m3": after["volume_stored_m3"],
        })
        print("Pond at", (round(lon, 5), round(lat, 5)), "->", single_results[-1])

    failures = []

    # Same size -> same storage volume. This is CORRECT, not a bug.
    volumes = set(r["volume_stored_m3"] for r in single_results)
    if len(volumes) != 1:
        failures.append(f"Expected identical volume_stored_m3 for same-sized ponds, got {volumes}")

    # Different locations -> different protected ground. If every pond
    # protects an identical area, the location input isn't reaching the
    # calculation (the exact bug being guarded against here).
    area_saved_values = [r["area_saved_m2"] for r in single_results]
    pixel_values = [r["pixels_saved"] for r in single_results]
    if len(set(area_saved_values)) == 1 and len(set(pixel_values)) == 1:
        failures.append(
            "All ponds at different locations report IDENTICAL area_saved_m2/pixels_saved "
            f"({area_saved_values}, {pixel_values}) — location is not affecting the outcome."
        )

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(" -", f)
        sys.exit(1)

    print("\nPASSED: same-sized measures at different locations report identical volume "
          "(size-based, correct) but different protected area (location-based, correct).")


if __name__ == "__main__":
    main()
