import osmnx as ox

# Our locked bounding box: Saidpur -> Margalla foothills -> Blue Area -> G-9/G-10
north, south = 33.7350, 33.6700
east, west = 73.0850, 73.0100
bbox = (west, south, east, north)

print("Downloading road network... this may take a minute")
roads = ox.graph_from_bbox(bbox, network_type="drive")
ox.save_graphml(roads, "roads.graphml")
print("Roads saved to roads.graphml")

print("Downloading buildings...")
buildings = ox.features_from_bbox(bbox, tags={"building": True})
buildings.to_file("buildings.geojson", driver="GeoJSON")
print("Buildings saved to buildings.geojson")