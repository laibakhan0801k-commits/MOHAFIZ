"""
Real routing on the actual road network (roads.graphml), using NetworkX.
Finds the shortest real path between any two points, and can compute a
flood-safe alternative that avoids currently flooded road segments.
"""

import networkx as nx
import osmnx as ox

from road_flooding import load_roads, get_flooded_roads


def nearest_node(lat: float, lon: float):
    G = load_roads()
    return ox.distance.nearest_nodes(G, X=lon, Y=lat)


def _get_edge(G, u, v):
    data = G.get_edge_data(u, v)
    return data[0] if 0 in data else list(data.values())[0]


def _path_to_coords(G, path):
    coords = []
    for i in range(len(path) - 1):
        edge = _get_edge(G, path[i], path[i + 1])
        if "geometry" in edge:
            pts = [[pt[0], pt[1]] for pt in edge["geometry"].coords]
        else:
            u, v = path[i], path[i + 1]
            pts = [[G.nodes[u]["x"], G.nodes[u]["y"]], [G.nodes[v]["x"], G.nodes[v]["y"]]]
        if coords and coords[-1] == pts[0]:
            coords.extend(pts[1:])
        else:
            coords.extend(pts)
    return coords


def _path_length_m(G, path):
    return sum(_get_edge(G, path[i], path[i + 1]).get("length", 0) for i in range(len(path) - 1))


def find_route(start_lat, start_lon, end_lat, end_lon):
    """Shortest real route on the road network, ignoring flooding."""
    G = load_roads()
    start_node = nearest_node(start_lat, start_lon)
    end_node = nearest_node(end_lat, end_lon)

    path = nx.shortest_path(G, start_node, end_node, weight="length")
    return {
        "path_nodes": path,
        "coords": _path_to_coords(G, path),
        "length_m": round(_path_length_m(G, path), 1),
        "reachable": True,
    }


def _flooded_edge_set(water_level_m):
    result = get_flooded_roads(water_level_m)
    flooded = set()
    for e in result["flooded_edges"]:
        flooded.add((e["u"], e["v"]))
        flooded.add((e["v"], e["u"]))
    return flooded


def route_crosses_flood(route_result, water_level_m):
    """Check whether a given route crosses any currently flooded road."""
    flooded_pairs = _flooded_edge_set(water_level_m)
    path = route_result["path_nodes"]
    return any((path[i], path[i + 1]) in flooded_pairs for i in range(len(path) - 1))


def find_flood_safe_route(start_lat, start_lon, end_lat, end_lon, water_level_m):
    """
    Shortest route that avoids any road segment currently underwater.
    Returns reachable=False if no such path exists.
    """
    G = load_roads()
    flooded_pairs = _flooded_edge_set(water_level_m)

    G_safe = G.copy()
    edges_to_remove = [(u, v, k) for u, v, k in G_safe.edges(keys=True) if (u, v) in flooded_pairs]
    G_safe.remove_edges_from(edges_to_remove)

    start_node = nearest_node(start_lat, start_lon)
    end_node = nearest_node(end_lat, end_lon)

    try:
        path = nx.shortest_path(G_safe, start_node, end_node, weight="length")
        return {
            "path_nodes": path,
            "coords": _path_to_coords(G_safe, path),
            "length_m": round(_path_length_m(G_safe, path), 1),
            "reachable": True,
        }
    except nx.NetworkXNoPath:
        return {"reachable": False}