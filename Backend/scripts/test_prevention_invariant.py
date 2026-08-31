"""
Regression test: a prevention plan must never look worse than doing
nothing. For every (cause_type, water_level, actions) combination below,
every "after" metric must be <= its "before" counterpart.

This guards against the two real bugs found in practice:
  1. Structural interventions (ponds, widened channels) diluting their
     intercepted volume across the whole DEM for river/dam causes, so
     they had ~zero visible effect (fixed: local protection zones).
  2. An intervention's own dug footprint (its engineered water storage)
     being counted as NEW flood damage in the after-stats, making plans
     look like they made things worse (fixed: exclude_engineered_footprint).

Run with: venv/Scripts/python.exe scripts/test_prevention_invariant.py
"""
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flood_engine
from main import _run_prevention_sim

CLAMPED_METRICS = ("flooded_percent", "flooded_pixels", "roads_cut",
                   "buildings_affected", "avg_depth_m", "max_depth_m")


def _flooded_pixel(elevation, bounds, water_level_m):
    """Find a real DEM pixel that is actually underwater at this level —
    placing test actions on dry land would trivially pass (no effect to
    check), so every case below is anchored to genuine flooded ground."""
    import numpy as np
    west, south, east, north = bounds
    H, W = elevation.shape
    flooded = elevation <= water_level_m
    rows, cols = np.where(flooded)
    if len(rows) == 0:
        raise RuntimeError(f"No flooded pixels at water_level_m={water_level_m}; pick a bigger scenario")
    r, c = rows[len(rows) // 2], cols[len(cols) // 2]
    lon = west + (c + 0.5) / W * (east - west)
    lat = north - (r + 0.5) / H * (north - south)
    return lon, lat


def run_case(label, cause_type, params, water_level_m, actions):
    elevation, valid = flood_engine.load_dem()
    bounds = flood_engine.get_dem_bounds()

    before, after, _, _, _, _, _ = _run_prevention_sim(
        cause_type, params, actions, elevation, bounds,
        direct_water_level_m=water_level_m,
    )

    failures = []
    for key in CLAMPED_METRICS:
        if after[key] > before[key]:
            failures.append(f"{key}: before={before[key]} after={after[key]} (after > before)")

    status = "PASS" if not failures else "FAIL"
    print(f"[{status}] {label}")
    print(f"  before: {before}")
    print(f"  after:  {after}")
    for f in failures:
        print(f"  VIOLATION: {f}")
    return failures


def main():
    elevation, valid = flood_engine.load_dem()
    bounds = flood_engine.get_dem_bounds()

    cases = []

    # River overflow: exercises the local-protection path (bug #1).
    wl = 512.0
    lon, lat = _flooded_pixel(elevation, bounds, wl)
    cases.append((
        "river_overflow + retention pond (local protection path)",
        "river_overflow", {"bank_rise_m": 0.55}, wl,
        [{"uid": 1, "type": "retentionPond", "lat": lat, "lon": lon,
          "params": {"surface_area_m2": 10000, "depth_m": 3}}],
    ))
    cases.append((
        "river_overflow + widened channel",
        "river_overflow", {"bank_rise_m": 0.55}, wl,
        [{"uid": 2, "type": "widenChannel",
          "line_coords": [[lon - 0.001, lat - 0.001], [lon + 0.001, lat + 0.001]],
          "params": {"new_width_m": 15, "section_length_m": 100}}],
    ))

    # Rainfall: exercises the global volume-conservation path + the
    # engineered-footprint exclusion (bug #2).
    wl2 = 515.3
    lon2, lat2 = _flooded_pixel(elevation, bounds, wl2)
    cases.append((
        "rainfall + retention pond (engineered-footprint exclusion)",
        "rainfall", {"intensity_mm_per_hr": 40, "duration_hr": 3}, wl2,
        [{"uid": 3, "type": "retentionPond", "lat": lat2, "lon": lon2,
          "params": {"surface_area_m2": 10000, "depth_m": 3}}],
    ))
    cases.append((
        "rainfall + pond + widening + desilt combined",
        "rainfall", {"intensity_mm_per_hr": 40, "duration_hr": 3}, wl2,
        [
            {"uid": 4, "type": "retentionPond", "lat": lat2, "lon": lon2,
             "params": {"surface_area_m2": 5000, "depth_m": 2}},
            {"uid": 5, "type": "widenChannel",
             "line_coords": [[lon2 - 0.001, lat2 - 0.001], [lon2 + 0.001, lat2 + 0.001]],
             "params": {"new_width_m": 15, "section_length_m": 100}},
            {"uid": 6, "type": "desilt", "target_waterway_id": None,
             "params": {"length": 100}},
        ],
    ))

    # Dam release: same local-protection path as river overflow.
    wl3 = 513.0
    lon3, lat3 = _flooded_pixel(elevation, bounds, wl3)
    cases.append((
        "dam_release + encroachment removal",
        "dam_release", {"release_intensity_pct": 60}, wl3,
        [{"uid": 7, "type": "removeEncroachment", "lat": lat3, "lon": lon3, "params": {}}],
    ))

    all_failures = []
    for label, cause_type, params, wl_case, actions in cases:
        all_failures += run_case(label, cause_type, params, wl_case, actions)
        print()

    if all_failures:
        print(f"FAILED: {len(all_failures)} invariant violation(s) across {len(cases)} case(s).")
        sys.exit(1)
    print(f"PASSED: all {len(cases)} case(s) satisfy after <= before for every metric.")


if __name__ == "__main__":
    main()
