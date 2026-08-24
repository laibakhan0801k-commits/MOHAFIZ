import sys, os, json
import matplotlib.pyplot as plt
import numpy as np

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flood_engine import load_dem, severity_to_water_level, rainfall_severity, compute_flood_extent
from routing import find_route, find_flood_safe_route, route_crosses_flood

with open("facilities.geojson", encoding="utf-8") as f:
    facilities = json.load(f)

def feature_centroid(feature):
    geom = feature["geometry"]
    if geom["type"] == "Point":
        return geom["coordinates"][1], geom["coordinates"][0]
    if geom["type"] == "Polygon":
        ring = geom["coordinates"][0]
        return sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring)
    return None

hospital = next(
    f for f in facilities["features"]
    if f["properties"].get("amenity") in ("hospital", "clinic", "doctors") and f["properties"].get("name")
)
hosp_lat, hosp_lon = feature_centroid(hospital)
print(f"Routing to: {hospital['properties'].get('name')} at ({hosp_lat:.5f}, {hosp_lon:.5f})")

start_lat, start_lon = 33.7060, 73.0380  # a point in the G-9 residential area

try:
    direct = find_route(start_lat, start_lon, hosp_lat, hosp_lon)
    print(f"Direct route: {direct['length_m']/1000:.2f} km, {len(direct['path_nodes'])} nodes")
except Exception as e:
    print(f"Direct route failed: {e}")
    direct = None

# A serious but realistic storm — strong enough to cross the route,
# not so extreme it floods the whole map including mountain peaks
severity = rainfall_severity(intensity_mm_per_hr=70, duration_hr=3)
water_level = severity_to_water_level(severity)
print(f"Flood scenario: severity={severity:.1f}, water_level={water_level:.1f}m")

crosses = route_crosses_flood(direct, water_level) if direct else None
print(f"Does the direct route cross flooded roads? {crosses}")

safe = find_flood_safe_route(start_lat, start_lon, hosp_lat, hosp_lon, water_level)
if safe["reachable"]:
    print(f"Flood-safe route: {safe['length_m']/1000:.2f} km")
else:
    print("No flood-safe route exists — hospital is cut off by this flood!")

elevation, _ = load_dem()
flooded_mask, _ = compute_flood_extent(water_level)
extent = [73.0100, 73.0850, 33.6700, 33.7350]

fig, ax = plt.subplots(figsize=(9, 8))
ax.imshow(elevation, cmap="gray", extent=extent)
ax.imshow(np.where(flooded_mask, 1, np.nan), cmap="Blues", alpha=0.5, vmin=0, vmax=1, extent=extent)

if direct:
    xs, ys = [c[0] for c in direct["coords"]], [c[1] for c in direct["coords"]]
    label = "Direct route" + (" (CROSSES FLOOD)" if crosses else "")
    ax.plot(xs, ys, color="orange", linewidth=3, label=label, zorder=3)

if safe["reachable"]:
    xs2, ys2 = [c[0] for c in safe["coords"]], [c[1] for c in safe["coords"]]
    ax.plot(xs2, ys2, color="lime", linewidth=2, linestyle="--", label="Flood-safe route", zorder=4)

ax.scatter([start_lon], [start_lat], color="white", edgecolor="black", s=80, zorder=5, label="Start")
ax.scatter([hosp_lon], [hosp_lat], color="red", s=100, marker="+", zorder=5, label="Hospital")
ax.legend(loc="upper left", fontsize=9)
ax.set_title(f"Routing to {hospital['properties'].get('name')} — water level {water_level:.0f}m")
plt.savefig("routing_test.png", dpi=150, bbox_inches="tight")
print("Saved: routing_test.png")