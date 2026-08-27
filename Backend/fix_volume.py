with open("flood_engine.py", encoding="utf-8") as f:
    content = f.read()

# --- 1. Add volume-based constants and functions after get_dem_bounds ---
marker = "def severity_to_water_level(severity: float) -> float:"
start = content.find(marker)
end = content.find("\ndef ", start + 10)

new_block = '''# Real physical dimensions of this DEM, computed from its actual
# resolution at this latitude (~33.7 N). Used for volume conservation.
PIXEL_AREA_M2 = 795.5


def get_catchment_area_m2():
    """Total real ground area covered by valid DEM pixels, in square meters."""
    _, valid = load_dem()
    return len(valid) * PIXEL_AREA_M2


def volume_stored_below(level_m: float) -> float:
    """
    How much water (cubic meters) the terrain can physically hold below a
    given elevation. This is the sum of water depth over every pixel that
    sits below that level, times each pixel's real ground area.
    """
    _, valid = load_dem()
    depths = np.maximum(0, level_m - valid)
    return float(np.sum(depths) * PIXEL_AREA_M2)


def water_level_from_volume(runoff_volume_m3: float) -> float:
    """
    VOLUME-CONSERVING FLOOD MODEL.

    Instead of arbitrarily raising water to a percentile of terrain, this
    finds the water level at which the terrain's real storage capacity
    equals the actual volume of runoff produced. This is conservation of
    mass - the same principle real hydrological models use.

    Fixes the earlier bug where the model reported absurd water depths
    (30m+) because it never checked whether enough water actually existed
    to fill the basin to that height.

    Uses binary search since storage capacity rises non-linearly with
    elevation (wider basins hold disproportionately more water).
    """
    _, valid = load_dem()

    if runoff_volume_m3 <= 0:
        return float(np.min(valid)) - 1.0

    lo = float(np.min(valid))
    hi = float(np.max(valid))

    for _ in range(60):
        mid = (lo + hi) / 2
        if volume_stored_below(mid) < runoff_volume_m3:
            lo = mid
        else:
            hi = mid

    return (lo + hi) / 2


def rainfall_to_water_level(rain_mm: float, runoff_coefficient: float = 0.6) -> float:
    """
    Convert a real rainfall total (mm) into the water level it can
    physically produce across this catchment.

    runoff_coefficient reflects how much rain becomes surface runoff
    rather than soaking into ground or being cleared by drains. 0.6 is a
    standard value for a partly-urbanised catchment like this corridor.
    """
    rain_m = rain_mm / 1000
    runoff_volume_m3 = rain_m * runoff_coefficient * get_catchment_area_m2()
    return water_level_from_volume(runoff_volume_m3)


def compute_depth_stats(water_level_m: float):
    """
    Returns realistic depth figures over the ACTUALLY flooded area,
    not the single deepest channel point (which was misleading users).
    """
    _, valid = load_dem()
    flooded_cells = valid[valid <= water_level_m]

    if len(flooded_cells) == 0:
        return {"avg_depth_m": 0.0, "max_depth_m": 0.0}

    depths = water_level_m - flooded_cells
    return {
        "avg_depth_m": round(float(np.mean(depths)), 2),
        "max_depth_m": round(float(np.max(depths)), 2),
    }


def severity_to_water_level(severity: float) -> float:
    """
    LEGACY percentile mapping, kept only for causes that do not have a
    real rainfall volume to work from (river overflow, dam release).
    Rainfall and drainage failure now use the volume-conserving path.
    """
    MAX_FLOOD_PERCENTILE = 70

    severity = max(0, min(100, severity))
    _, valid = load_dem()

    if severity <= 0:
        return float(np.min(valid)) - 1.0

    effective_percentile = (severity / 100) * MAX_FLOOD_PERCENTILE
    return float(np.percentile(valid, effective_percentile))
'''

content = content[:start] + new_block + content[end:]

with open("flood_engine.py", "w", encoding="utf-8") as f:
    f.write(content)

print("flood_engine.py updated")
with open("flood_engine.py", encoding="utf-8") as f:
    c = f.read()
    for name in ["water_level_from_volume", "rainfall_to_water_level", "compute_depth_stats", "volume_stored_below"]:
        print(f"  {name}:", name in c)
