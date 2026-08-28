import sys, os
import numpy as np
import matplotlib.pyplot as plt

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import flood_engine
from flood_engine import (
    load_dem, get_dem_bounds, rainfall_severity, rainfall_to_water_level,
    compute_flood_extent_on_array, apply_line_raise,
)
import road_flooding
from road_flooding import get_flooded_roads_on_array

elevation, valid = load_dem()
bounds = get_dem_bounds()
west, south, east, north = bounds
H, W = elevation.shape

intensity_mm_per_hr = 20
duration_hr = 4
rain_mm = intensity_mm_per_hr * duration_hr  # 80mm total

severity = rainfall_severity(intensity_mm_per_hr, duration_hr)
water_level = rainfall_to_water_level(rain_mm)

print(f"Scenario: {rain_mm}mm total rain -> severity={severity:.1f} (display only), water_level={water_level:.2f}m")

before_mask, before_stats = compute_flood_extent_on_array(elevation, water_level)
before_roads = get_flooded_roads_on_array(water_level, elevation, bounds)
print(f"BEFORE: {before_stats['flooded_percent']}% flooded ({before_stats['flooded_pixels']} raw pixels), {before_roads['flooded_edge_count']} roads cut")

# ---------------------------------------------------------------------
# Find the most marginal flooded road node: currently flooded, with the
# SMALLEST gap between its elevation and the water level. This is the
# road an embankment could most plausibly save -- and it guarantees the
# test embankment sits somewhere that actually matters to the road
# network, not an arbitrary DEM elevation match.
# ---------------------------------------------------------------------
G = road_flooding.load_roads()
NODATA_FLOOR = -1000

candidates = []
for node_id in G.nodes:
    lon = G.nodes[node_id]["x"]
    lat = G.nodes[node_id]["y"]
    elev = flood_engine.sample_elevation_from_array(elevation, bounds, lon, lat)
    if elev > NODATA_FLOOR and elev <= water_level:
        margin = water_level - elev
        candidates.append((margin, node_id, lon, lat, elev))

if not candidates:
    print("\nNo flooded road nodes found at this water level -- can't test road-saving here.")
    sys.exit(1)

candidates.sort(key=lambda c: c[0])
margin, target_node, target_lon, target_lat, target_elev = candidates[0]
print(f"\nMost marginal flooded road node: node={target_node}, lon={target_lon:.5f}, lat={target_lat:.5f}, elevation={target_elev:.2f}m, margin={margin:.2f}m below water level")
print(f"(For reference: {len(candidates)} road nodes are flooded at this water level)")

# 300m embankment, north-south, centered on that road node.
m_per_deg_lat = 111320
half_length_deg_lat = 150 / m_per_deg_lat

embankment_line = [
    [target_lon, target_lat - half_length_deg_lat],
    [target_lon, target_lat + half_length_deg_lat],
]
embankment_height_m = 2.5
print(f"Embankment height: {embankment_height_m}m (margin was {margin:.2f}m, so this should be enough to clear it)")

# Diagnostic: check elevation at embankment endpoints
from flood_engine import sample_elevation_from_array
for i, (lon, lat) in enumerate(embankment_line):
    elev = sample_elevation_from_array(elevation, bounds, lon, lat)
    print(f"Embankment endpoint {i}: ({lon}, {lat}) elevation = {elev:.1f}m (water level = {water_level:.1f}m)")

embankment_height_m = 5.0

modified_elevation = apply_line_raise(elevation, bounds, embankment_line, embankment_height_m, buffer_m=15)

touched = np.where(modified_elevation != elevation)
print(f"\n[DIAGNOSTIC] Pixels raised: {len(touched[0])}")

after_mask, after_stats = compute_flood_extent_on_array(modified_elevation, water_level)
after_roads = get_flooded_roads_on_array(water_level, modified_elevation, bounds)
print(f"AFTER:  {after_stats['flooded_percent']}% flooded ({after_stats['flooded_pixels']} raw pixels), {after_roads['flooded_edge_count']} roads cut")

pixel_diff = before_stats['flooded_pixels'] - after_stats['flooded_pixels']
print(f"\nRaw flooded-pixel difference: {pixel_diff} pixels ({pixel_diff * flood_engine.PIXEL_AREA_M2:.0f} m2 of land no longer flooded)")
print(f"Roads saved: {before_roads['flooded_edge_count'] - after_roads['flooded_edge_count']}")

# Zoomed visual around the target road node
zoom_half_deg = 0.01
zoom_col_min = max(0, int((target_lon - zoom_half_deg - west) / (east - west) * W))
zoom_col_max = min(W, int((target_lon + zoom_half_deg - west) / (east - west) * W))
zoom_row_min = max(0, int((north - (target_lat + zoom_half_deg)) / (north - south) * H))
zoom_row_max = min(H, int((north - (target_lat - zoom_half_deg)) / (north - south) * H))

fig, axes = plt.subplots(1, 2, figsize=(16, 7))

axes[0].imshow(elevation[zoom_row_min:zoom_row_max, zoom_col_min:zoom_col_max], cmap="gray")
axes[0].imshow(np.where(before_mask, 1, np.nan)[zoom_row_min:zoom_row_max, zoom_col_min:zoom_col_max], cmap="Blues", alpha=0.6, vmin=0, vmax=1)
axes[0].set_title(f"BEFORE -- {before_roads['flooded_edge_count']} roads cut (full area)")
axes[0].axis("off")

axes[1].imshow(modified_elevation[zoom_row_min:zoom_row_max, zoom_col_min:zoom_col_max], cmap="gray")
axes[1].imshow(np.where(after_mask, 1, np.nan)[zoom_row_min:zoom_row_max, zoom_col_min:zoom_col_max], cmap="Blues", alpha=0.6, vmin=0, vmax=1)
axes[1].set_title(f"AFTER embankment -- {after_roads['flooded_edge_count']} roads cut (full area)")
axes[1].axis("off")

plt.tight_layout()
plt.savefig("embankment_before_after.png", dpi=150, bbox_inches="tight")
print("\nSaved: embankment_before_after.png (zoomed to the targeted road node)")