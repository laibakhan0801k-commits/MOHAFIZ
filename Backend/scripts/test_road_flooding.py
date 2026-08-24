import sys
import os
import matplotlib.pyplot as plt
import numpy as np

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flood_engine import load_dem, severity_to_water_level, rainfall_severity
from road_flooding import get_flooded_roads

severity = rainfall_severity(intensity_mm_per_hr=50, duration_hr=3)
water_level = severity_to_water_level(severity)
result = get_flooded_roads(water_level)

print(f"Water level: {water_level:.1f}m")
print(f"Flooded intersections: {result['flooded_node_count']} / {result['total_node_count']}")
print(f"Flooded road segments: {result['flooded_edge_count']}")
print(f"Clear road segments: {result['clear_edge_count']}")

elevation, _ = load_dem()

fig, ax = plt.subplots(figsize=(9, 8))
ax.imshow(elevation, cmap="gray", extent=[73.0100, 73.0850, 33.6700, 33.7350])

for edge in result["clear_edges"]:
    xs = [c[0] for c in edge["coords"]]
    ys = [c[1] for c in edge["coords"]]
    ax.plot(xs, ys, color="lime", linewidth=0.5, alpha=0.6)

for edge in result["flooded_edges"]:
    xs = [c[0] for c in edge["coords"]]
    ys = [c[1] for c in edge["coords"]]
    ax.plot(xs, ys, color="red", linewidth=1.2)

ax.set_title(f"Roads at {water_level:.0f}m — red = cut ({result['flooded_edge_count']} segments), green = clear")
plt.savefig("road_flooding_test.png", dpi=150, bbox_inches="tight")
print("Saved: road_flooding_test.png")