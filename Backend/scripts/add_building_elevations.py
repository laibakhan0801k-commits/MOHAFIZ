import json
import rasterio

with open("buildings.geojson", encoding="utf-8") as f:
    data = json.load(f)

dem = rasterio.open("elevation.tif")

def centroid(geom):
    coords = geom["coordinates"]
    if geom["type"] == "Polygon":
        ring = coords[0]
    elif geom["type"] == "MultiPolygon":
        ring = coords[0][0]
    else:
        return None
    xs = [pt[0] for pt in ring]
    ys = [pt[1] for pt in ring]
    return (sum(xs) / len(xs), sum(ys) / len(ys))

updated = 0
for feature in data["features"]:
    c = centroid(feature["geometry"])
    if c is None:
        feature["properties"]["base_elevation_m"] = None
        continue
    sampled = list(dem.sample([c]))
    feature["properties"]["base_elevation_m"] = float(sampled[0][0])
    updated += 1

with open("buildings.geojson", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)

print("Updated " + str(updated) + " buildings with base_elevation_m")
