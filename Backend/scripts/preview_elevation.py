import rasterio
import numpy as np
import matplotlib.pyplot as plt

with rasterio.open("elevation.tif") as src:
    elevation = src.read(1).astype(float)
    nodata = src.nodata

    print("Size:", src.width, "x", src.height, "pixels")
    print("CRS:", src.crs)
    print("Bounds:", src.bounds)

    valid = elevation[elevation != nodata]
    print(f"\nValid elevation pixels: {len(valid)} / {elevation.size}")
    print(f"Missing/nodata pixels: {elevation.size - len(valid)}")
    print(f"Min elevation: {valid.min():.1f} m")
    print(f"Max elevation: {valid.max():.1f} m")
    print(f"Mean elevation: {valid.mean():.1f} m")
    print(f"Relief (max-min): {valid.max() - valid.min():.1f} m")

    # Mask nodata so it doesn't wreck the color scale
    display = np.where(elevation == nodata, np.nan, elevation)

    plt.figure(figsize=(8, 7))
    plt.imshow(display, cmap="terrain")
    plt.colorbar(label="Elevation (m)")
    plt.title("MOHAFIZ Study Area — Elevation (Nullah Leh corridor)")
    plt.savefig("elevation_preview.png", dpi=150, bbox_inches="tight")
    print("\nSaved: elevation_preview.png — open this file to see the terrain shape")