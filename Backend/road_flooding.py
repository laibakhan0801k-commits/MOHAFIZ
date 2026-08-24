"""
Checks which real road intersections/segments from roads.graphml
go underwater at a given flood water level.
"""

import osmnx as ox
import rasterio

ROADS_PATH = "roads.graphml"
DEM_PATH = "elevation.tif"

_graph_cache = None
_dem_cache = None


def load_roads():
    global _graph_cache
    if _graph_cache is None:
        _graph_cache = ox.load_graphml(ROADS_PATH)
    return _graph_cache


def load_dem_dataset():
    global _dem_cache
    if _dem_cache is None:
        _dem_cache = rasterio.open(DEM_PATH)
    return _dem_cache


def get_flooded_roads(water_level_m: float):
    """
    Returns:
      flooded_node_count, total_node_count,
      flooded_edges: list of (u, v, geometry as [[lon,lat], ...]) that are cut
      clear_edges: same shape, for roads still passable
    """
    G = load_roads()
    dem = load_dem_dataset()

    # Sample elevation at every intersection in one batch (fast)
    node_ids = list(G.nodes)
    coords = [(G.nodes[n]["x"], G.nodes[n]["y"]) for n in node_ids]  # (lon, lat)
    elevations = [val[0] for val in dem.sample(coords)]

    node_flooded = {
        node_id: (elev <= water_level_m)
        for node_id, elev in zip(node_ids, elevations)
    }

    flooded_edges = []
    clear_edges = []

    for u, v, data in G.edges(data=True):
        is_flooded = node_flooded.get(u, False) or node_flooded.get(v, False)

        if "geometry" in data:
            coords_list = [[pt[0], pt[1]] for pt in data["geometry"].coords]
        else:
            coords_list = [
                [G.nodes[u]["x"], G.nodes[u]["y"]],
                [G.nodes[v]["x"], G.nodes[v]["y"]],
            ]

        entry = {
            "u": int(u),
            "v": int(v),
            "coords": [[float(c[0]), float(c[1])] for c in coords_list],
        }
        (flooded_edges if is_flooded else clear_edges).append(entry)

    flooded_node_count = sum(node_flooded.values())

    return {
        "flooded_node_count": flooded_node_count,
        "total_node_count": len(node_ids),
        "flooded_edge_count": len(flooded_edges),
        "clear_edge_count": len(clear_edges),
        "flooded_edges": flooded_edges,
        "clear_edges": clear_edges,
    }