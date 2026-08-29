"""
Real routing on the actual road network (roads.graphml), using NetworkX.
Finds the shortest real path between any two points, and can compute a
flood-safe alternative that avoids currently flooded road segments.
"""

import networkx as nx
import numpy as np

from road_flooding import load_roads, get_flooded_roads


_node_index_cache = None


def _node_index():
    """Cached arrays of node ids and their lon/lat, for nearest-node lookup."""
    global _node_index_cache
    if _node_index_cache is None:
        G = load_roads()
        ids = list(G.nodes)
        lons = np.array([G.nodes[n]["x"] for n in ids], dtype=float)
        lats = np.array([G.nodes[n]["y"] for n in ids], dtype=float)
        _node_index_cache = (ids, lons, lats)
    return _node_index_cache


def nearest_node(lat: float, lon: float):
    """
    Nearest graph node to a real lat/lon.

    Replaces osmnx's nearest_nodes(). On an UNPROJECTED graph -- and this
    one is EPSG:4326 -- osmnx needs scikit-learn as an optional dependency
    to build a BallTree. Without it every call raised ImportError and the
    /route endpoint returned a 500, so rescue routing never worked at all.
    A vectorised haversine over this graph's ~4.7k nodes needs no extra
    dependency and is faster than building a tree for a graph this size.
    """
    ids, lons, lats = _node_index()

    lat1, lon1 = np.radians(lat), np.radians(lon)
    lat2, lon2 = np.radians(lats), np.radians(lons)

    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    # 6371008.8 m -- IUGG mean Earth radius, the same figure osmnx uses.
    dist_m = 6371008.8 * 2 * np.arcsin(np.sqrt(a))

    return ids[int(np.argmin(dist_m))]


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

    try:
        path = nx.shortest_path(G, start_node, end_node, weight="length")
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        # The two points sit in disconnected parts of the road network.
        # That is a real ANSWER ("you cannot drive there"), not a server
        # fault -- callers must receive reachable=False rather than a 500,
        # so the UI can say so plainly instead of failing silently.
        return {"path_nodes": [], "coords": [], "length_m": 0, "reachable": False}

    return {
        "path_nodes": path,
        "coords": _path_to_coords(G, path),
        "length_m": round(_path_length_m(G, path), 1),
        "reachable": True,
    }


# Cached per water level. Each route call needs the flooded-edge set twice
# (once to test the direct route, once to build the safe graph), and the
# plan page fires one route per affected hospital the moment a start point
# is set -- so without caching a single click triggers dozens of identical
# full-DEM sweeps. Keyed on the water level, so a NEW simulation never
# reuses an old flood picture.
_flooded_edges_cache = {}
_safe_graph_cache = {}
_ROUTING_CACHE_MAX = 8


def _cache_key(water_level_m):
    return round(float(water_level_m), 3)


def _trim(cache):
    # Water levels per session are few; this only stops unbounded growth.
    while len(cache) > _ROUTING_CACHE_MAX:
        cache.pop(next(iter(cache)))


def _flooded_edge_set(water_level_m):
    key = _cache_key(water_level_m)
    if key not in _flooded_edges_cache:
        result = get_flooded_roads(water_level_m)
        flooded = set()
        for e in result["flooded_edges"]:
            flooded.add((e["u"], e["v"]))
            flooded.add((e["v"], e["u"]))
        _flooded_edges_cache[key] = flooded
        _trim(_flooded_edges_cache)
    return _flooded_edges_cache[key]


def normalise_closures(closed_edges):
    """
    Turn the frontend's [[u, v], ...] into the set of directed node pairs to
    drop. A physical road closure blocks BOTH directions, so each pair is
    added forwards and backwards — the graph stores a two-way street as two
    directed edges and a barrier stops traffic either way.
    """
    pairs = set()
    for edge in (closed_edges or []):
        if not edge or len(edge) < 2:
            continue
        u, v = edge[0], edge[1]
        if u is None or v is None:
            continue
        pairs.add((u, v))
        pairs.add((v, u))
    return frozenset(pairs)


def _safe_graph(water_level_m, closed_pairs=frozenset()):
    """
    The road network with every currently-flooded segment removed, and
    optionally the roads this plan has closed by hand removed as well.

    Keyed on BOTH the water level and the exact closure set, so a new
    simulation or a newly-closed road can never reuse an older network.
    """
    key = (_cache_key(water_level_m), closed_pairs)
    if key not in _safe_graph_cache:
        G = load_roads()
        blocked = set(_flooded_edge_set(water_level_m)) | set(closed_pairs)
        G_safe = G.copy()
        G_safe.remove_edges_from(
            [(u, v, k) for u, v, k in G_safe.edges(keys=True) if (u, v) in blocked]
        )
        _safe_graph_cache[key] = G_safe
        _trim(_safe_graph_cache)
    return _safe_graph_cache[key]


def _graph_without(closed_pairs):
    """The full network minus only the hand-closed roads (flooding ignored)."""
    key = ('noflood', closed_pairs)
    if key not in _safe_graph_cache:
        G = load_roads().copy()
        G.remove_edges_from(
            [(u, v, k) for u, v, k in G.edges(keys=True) if (u, v) in closed_pairs]
        )
        _safe_graph_cache[key] = G
        _trim(_safe_graph_cache)
    return _safe_graph_cache[key]


def route_crosses_flood(route_result, water_level_m):
    """Check whether a given route crosses any currently flooded road."""
    flooded_pairs = _flooded_edge_set(water_level_m)
    path = route_result["path_nodes"]
    return any((path[i], path[i + 1]) in flooded_pairs for i in range(len(path) - 1))


def route_crosses_closures(route_result, closed_pairs):
    """Check whether a given route runs over a road this plan has closed."""
    path = route_result.get("path_nodes") or []
    return any((path[i], path[i + 1]) in closed_pairs for i in range(len(path) - 1))


def check_diversion(diversion_lat, diversion_lon, closure_u, closure_v,
                    water_level_m, closed_pairs=frozenset()):
    """
    Is a traffic diversion point actually placed where it can do its job?

    Two separate questions, answered on the REAL directed road network
    (the graph is a MultiDiGraph and carries oneway tags, so direction of
    travel is genuine information here, not an assumption):

      upstream  — can a driver at the diversion point still reach the
                  closed road's near end? If not, they never meet the
                  closure and turning them here achieves nothing. This
                  runs on the network minus the closures only: whether
                  traffic APPROACHES the closure does not depend on where
                  the floodwater is.

      alternative — with the closure (and the floodwater) removed from
                  play, can a driver at the diversion point still get to
                  the far side of the closed road? If not, this point
                  offers no way round and drivers must be turned back
                  further upstream.

    Either answer being False is worth showing; neither is fatal on its
    own, because OSM oneway data is not perfect and the planner may know
    the junction better than the map does.
    """
    result = {
        "upstream": None,
        "alternative_exists": None,
        "checked": False,
        "reason": None,
    }

    if closure_u is None or closure_v is None:
        result["reason"] = "the closure has no road identity to check against"
        return result

    G = load_roads()
    if closure_u not in G or closure_v not in G:
        result["reason"] = "the closed road is not in the routing network"
        return result

    try:
        d_node = nearest_node(diversion_lat, diversion_lon)
    except Exception:
        result["reason"] = "could not tie the diversion point to the road network"
        return result

    # Always exclude the closure itself from both tests, so neither can be
    # satisfied by driving through the very road that is shut.
    closure_only = frozenset({(closure_u, closure_v), (closure_v, closure_u)})
    all_closed = frozenset(set(closed_pairs) | set(closure_only))

    G_open = _graph_without(all_closed)
    G_safe = _safe_graph(water_level_m, all_closed)

    result["checked"] = True
    result["upstream"] = (
        d_node == closure_u or
        (d_node in G_open and nx.has_path(G_open, d_node, closure_u))
    )
    result["alternative_exists"] = (
        d_node in G_safe and closure_v in G_safe and nx.has_path(G_safe, d_node, closure_v)
    )
    return result


def find_flood_safe_route(start_lat, start_lon, end_lat, end_lon, water_level_m,
                          closed_pairs=frozenset()):
    """
    Shortest route that avoids any road segment currently underwater, and
    any road this plan has closed by hand.
    Returns reachable=False if no such path exists.
    """
    G_safe = _safe_graph(water_level_m, closed_pairs)

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