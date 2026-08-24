import sys
import os
import numpy as np
import matplotlib.pyplot as plt

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flood_engine import (
    load_dem, severity_to_water_level, compute_flood_extent,
    rainfall_severity, river_overflow_severity,
    drainage_failure_severity, dam_release_severity,
)

# One representative test scenario per cause type
scenarios = [
    ("Rainfall\n(50mm/hr, 3hr)", rainfall_severity(intensity_mm_per_hr=50, duration_hr=3)),
    ("River overflow\n(2.5m bank rise)", river_overflow_severity(bank_rise_m=2.5)),
    ("Drainage failure\n(60mm rain, 30% capacity)", drainage_failure_severity(rainfall_mm=60, drainage_capacity_pct=30)),
    ("Dam release\n(70% intensity)", dam_release_severity(release_intensity_pct=70)),
]

elevation, _ = load_dem()

fig, axes = plt.subplots(1, 4, figsize=(22, 6))

for ax, (label, severity) in zip(axes, scenarios):
    water_level = severity_to_water_level(severity)
    flooded, stats = compute_flood_extent(water_level)

    ax.imshow(elevation, cmap="gray")
    overlay = np.where(flooded, 1, np.nan)
    ax.imshow(overlay, cmap="autumn_r", vmin=0, vmax=1)
    ax.set_title(f"{label}\nseverity={severity:.0f} -> {water_level:.0f}m -> {stats['flooded_percent']}% flooded", fontsize=10)
    ax.axis("off")

    print(f"{label.splitlines()[0]}: severity={severity:.1f}, water_level={water_level:.1f}m, flooded={stats['flooded_percent']}%")

plt.tight_layout()
plt.savefig("flood_engine_test.png", dpi=150, bbox_inches="tight")
print("\nSaved: flood_engine_test.png")