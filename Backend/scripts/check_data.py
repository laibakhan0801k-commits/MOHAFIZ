import osmnx as ox
import geopandas as gpd

roads = ox.load_graphml("roads.graphml")
print(f"Roads: {len(roads.nodes)} intersections, {len(roads.edges)} road segments")

buildings = gpd.read_file("buildings.geojson")
print(f"Buildings: {len(buildings)} buildings")