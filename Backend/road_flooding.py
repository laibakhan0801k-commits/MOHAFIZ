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

    # DEM nodata pixels come back as large negative numbers (e.g. -32768).
    # Without this guard they always compare as "below water level" and get
    # falsely flagged as flooded even at zero severity.
    NODATA_FLOOR = -1000
    node_flooded = {
        node_id: (elev > NODATA_FLOOR and elev <= water_level_m)
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


def get_flooded_roads_on_array(water_level_m, elevation_array, dem_bounds):
    """
    Same logic as get_flooded_roads, but checks each road intersection
    against a MODIFIED elevation array instead of the real DEM file —
    lets us count roads cut BEFORE vs AFTER a prevention measure.
    """
    import numpy as np
    import flood_engine

    G = load_roads()
    node_ids = list(G.nodes)

    # elevation_array is NaN-encoded nodata (see flood_engine.load_dem), not
    # the raw -32768 sentinel, so we guard with isnan rather than a floor.
    node_flooded = {}
    for node_id in node_ids:
        lon = G.nodes[node_id]["x"]
        lat = G.nodes[node_id]["y"]
        elev = flood_engine.sample_elevation_from_array(elevation_array, dem_bounds, lon, lat)
        node_flooded[node_id] = (not np.isnan(elev) and elev <= water_level_m)

    flooded_edge_count = 0
    clear_edge_count = 0
    for u, v in G.edges():
        if node_flooded.get(u, False) or node_flooded.get(v, False):
            flooded_edge_count += 1
        else:
            clear_edge_count += 1

    return {
        "flooded_edge_count": flooded_edge_count,
        "clear_edge_count": clear_edge_count,
    }