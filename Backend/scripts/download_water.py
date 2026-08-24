import osmnx as ox

# Same locked bounding box as roads/buildings
north, south = 33.7350, 33.6700
east, west = 73.0850, 73.0100
bbox = (west, south, east, north)

print("Downloading waterways (Nullah Leh, Korang, tributaries, drains)...")
waterways = ox.features_from_bbox(bbox, tags={"waterway": True})
waterways.to_file("waterways.geojson", driver="GeoJSON")
print(f"Waterways saved: {len(waterways)} features")

print("Downloading water bodies (ponds, reservoirs, riverbanks)...")
water = ox.features_from_bbox(bbox, tags={"natural": "water"})
water.to_file("water_bodies.geojson", driver="GeoJSON")
print(f"Water bodies saved: {len(water)} features")