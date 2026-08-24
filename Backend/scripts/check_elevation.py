import rasterio

with rasterio.open("elevation.tif") as dem:
    data = dem.read(1)
    print(f"Grid size: {dem.width} x {dem.height} cells")
    print(f"Lowest point: {data.min()} meters")
    print(f"Highest point: {data.max()} meters")