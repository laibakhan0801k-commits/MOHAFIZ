import sys, os
import numpy as np
import matplotlib.pyplot as plt

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flood_engine import (
    load_dem, get_dem_bounds, rainfall_severity, severity_to_water_level,
    compute_flood_extent_on_array, apply_line_raise,
)
from road_flooding import get_flooded_roads_on_array

elevation, valid = load_dem()
bounds = get_dem_bounds()

# A real, moderate-to-serious rainfall scenario, same as our earlier tests
severity = rainfall_severity(intensity_mm_per_hr=50, duration_hr=3)
water_level = severity_to_water_level(severity)
print(f"Scenario: severity={severity:.1f}, water_level={water_level:.1f}m")

# BEFORE — real terrain, no intervention
before_mask, before_stats = compute_flood_extent_on_array(elevation, water_level)
before_roads = get_flooded_roads_on_array(water_level, elevation, bounds)
print(f"\nBEFORE: {before_stats['flooded_percent']}% flooded, {before_roads['flooded_edge_count']} roads cut")

# A test embankment — a real line, 300m long, 2.5m high, placed across
# a low-lying stretch inside the corridor
embankment_line = [
    [73.038, 33.704],
    [73.041, 33.706],
]
embankment_height_m = 2.5

modified_elevation = apply_line_raise(elevation, bounds, embankment_line, embankment_height_m)

# AFTER — same water level, modified terrain
after_mask, after_stats = compute_flood_extent_on_array(modified_elevation, water_level)
after_roads = get_flooded_roads_on_array(water_level, modified_elevation, bounds)
print(f"AFTER:  {after_stats['flooded_percent']}% flooded, {after_roads['flooded_edge_count']} roads cut")

print(f"\nDifference: {before_stats['flooded_percent'] - after_stats['flooded_percent']:.2f} percentage points")
print(f"Roads saved: {before_roads['flooded_edge_count'] - after_roads['flooded_edge_count']}")

# Visual side-by-side
fig, axes = plt.subplots(1, 2, figsize=(16, 7))

axes[0].imshow(elevation, cmap="gray")
axes[0].imshow(np.where(before_mask, 1, np.nan), cmap="Blues", alpha=0.6, vmin=0, vmax=1)
axes[0].set_title(f"BEFORE — {before_stats['flooded_percent']}% flooded, {before_roads['flooded_edge_count']} roads cut")
axes[0].axis("off")

axes[1].imshow(modified_elevation, cmap="gray")
axes[1].imshow(np.where(after_mask, 1, np.nan), cmap="Blues", alpha=0.6, vmin=0, vmax=1)
axes[1].set_title(f"AFTER embankment — {after_stats['flooded_percent']}% flooded, {after_roads['flooded_edge_count']} roads cut")
axes[1].axis("off")

plt.tight_layout()
plt.savefig("embankment_before_after.png", dpi=150, bbox_inches="tight")
print("\nSaved: embankment_before_after.png")
