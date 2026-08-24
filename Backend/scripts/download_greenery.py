import osmnx as ox

# Same locked bounding box
north, south = 33.7350, 33.6700
east, west = 73.0850, 73.0100
bbox = (west, south, east, north)

print("Downloading parks and green spaces...")
green = ox.features_from_bbox(
    bbox,
    tags={
        "leisure": ["park", "garden", "pitch", "playground", "golf_course"],
        "landuse": ["grass", "forest", "meadow", "recreation_ground", "village_green"],
        "natural": ["wood", "scrub", "grassland"],
    },
)
green.to_file("greenery.geojson", driver="GeoJSON")
print(f"Green spaces saved: {len(green)} features")