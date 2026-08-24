import rasterio
import numpy as np
import matplotlib.pyplot as plt

with rasterio.open("elevation.tif") as src:
    elevation = src.read(1).astype(float)
    nodata = src.nodata
    elevation = np.where(elevation == nodata, np.nan, elevation)

valid = elevation[~np.isnan(elevation)]

# Show the real distribution so we pick a sensible test number, not a guess
print("Elevation distribution in your study area:")
for p in [0, 10, 25, 50, 75, 90, 100]:
    print(f"  {p}th percentile: {np.percentile(valid, p):.1f} m")

# Pick a water level near the LOW end on purpose — a real flood event
# doesn't submerge 60% of a whole city corridor, it affects low-lying
# areas near the channel. Starting with the 15th percentile as a test.
water_level_m = round(np.percentile(valid, 15))
print(f"\nTesting water level: {water_level_m}m (roughly 15th percentile — a moderate flood)")

flooded = elevation <= water_level_m
valid_pixels = np.sum(~np.isnan(elevation))
flooded_pixels = np.sum(flooded)

print(f"Flooded pixels: {flooded_pixels} out of {valid_pixels} valid pixels")
print(f"Flooded percentage: {100 * flooded_pixels / valid_pixels:.1f}%")

# Grayscale terrain (so it can't be confused with the flood color)
fig, ax = plt.subplots(figsize=(8, 7))
ax.imshow(elevation, cmap="gray")

# Flood in bright red, fully opaque where flooded, invisible elsewhere
flood_overlay = np.where(flooded, 1, np.nan)
im = ax.imshow(flood_overlay, cmap="autumn_r", vmin=0, vmax=1)

ax.set_title(f"Flood test — water level {water_level_m}m ({100*flooded_pixels/valid_pixels:.1f}% flooded)")
plt.savefig("flood_test_preview.png", dpi=150, bbox_inches="tight")
print("Saved: flood_test_preview.png")