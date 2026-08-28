import sys, os, json

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import road_flooding

G = road_flooding.load_roads()

features = []
for u, v, data in G.edges(data=True):
    if "geometry" in data:
        coords_list = [[pt[0], pt[1]] for pt in data["geometry"].coords]
    else:
        coords_list = [
            [G.nodes[u]["x"], G.nodes[u]["y"]],
            [G.nodes[v]["x"], G.nodes[v]["y"]],
        ]

    features.append({
        "type": "Feature",
        "properties": {
            "u": int(u),
            "v": int(v),
            "highway": data.get("highway"),
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [[float(c[0]), float(c[1])] for c in coords_list],
        },
    })

geojson = {"type": "FeatureCollection", "features": features}

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
mohafiz_root = os.path.dirname(backend_dir)
out_path = os.path.join(mohafiz_root, "Frontend", "mohafizweb", "public", "data", "roads.geojson")

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(geojson, f)

print(f"Wrote {len(features)} road features to {out_path}")
