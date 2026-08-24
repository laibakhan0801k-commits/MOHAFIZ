"""
MOHAFIZ flood engine — bathtub-over-DEM model.

Core idea: every cause type (rainfall, river overflow, drainage failure,
dam release) computes its own "severity" score from 0-100 based on
simplified, documented assumptions. That severity is then mapped onto
the REAL elevation distribution of the study area, so a severity of 30
always means "roughly the lowest 30% of this specific terrain floods" —
self-calibrating to whatever area is loaded, not hardcoded meters.

This is a deliberately simplified hydrology model, appropriate for a
hackathon demo — not engineering-grade flood modelling. Assumptions are
labelled clearly so they can be explained and defended in a Q&A.
"""

import io
import base64
import rasterio
import numpy as np
from PIL import Image

DEM_PATH = "elevation.tif"

_elevation_cache = None
_valid_cache = None
_bounds_cache = None


def load_dem():
    """Load and cache the DEM so we don't re-read the file every call."""
    global _elevation_cache, _valid_cache
    if _elevation_cache is None:
        with rasterio.open(DEM_PATH) as src:
            elevation = src.read(1).astype(float)
            nodata = src.nodata
            _elevation_cache = np.where(elevation == nodata, np.nan, elevation)
            _valid_cache = _elevation_cache[~np.isnan(_elevation_cache)]
    return _elevation_cache, _valid_cache


def get_dem_bounds():
    """Returns (west, south, east, north) — the real geographic corners of the DEM."""
    global _bounds_cache
    if _bounds_cache is None:
        with rasterio.open(DEM_PATH) as src:
            b = src.bounds
            _bounds_cache = (b.left, b.bottom, b.right, b.top)
    return _bounds_cache


def severity_to_water_level(severity: float) -> float:
    """
    Convert a 0-100 severity score into an actual water level in meters,
    using the real elevation distribution of the loaded DEM.
    severity=30 -> the elevation below which ~30% of the terrain sits.
    """
    severity = max(0, min(100, severity))
    _, valid = load_dem()
    return float(np.percentile(valid, severity))


# ---------------------------------------------------------------------
# CAUSE TYPE 1: Rainfall
# ---------------------------------------------------------------------
def rainfall_severity(intensity_mm_per_hr: float, duration_hr: float, runoff_coefficient: float = 0.6) -> float:
    """
    ASSUMPTION: total effective rainfall = intensity x duration x runoff
    coefficient (how much rain becomes surface runoff vs. soaking in).
    REFERENCE_MM=200mm is treated as "severe, flood-triggering rainfall
    accumulation" based on historical Islamabad flood events -> severity 100.
    """
    REFERENCE_MM = 200
    effective_mm = intensity_mm_per_hr * duration_hr * runoff_coefficient
    return min(100, (effective_mm / REFERENCE_MM) * 100)


# ---------------------------------------------------------------------
# CAUSE TYPE 2: River overflow (Nullah Leh rises above its normal bank)
# ---------------------------------------------------------------------
def river_overflow_severity(bank_rise_m: float) -> float:
    """
    ASSUMPTION: MAX_REALISTIC_RISE_M=4m represents an extreme historical
    stage rise for Nullah Leh -> severity 100.
    """
    MAX_REALISTIC_RISE_M = 4
    return min(100, (bank_rise_m / MAX_REALISTIC_RISE_M) * 100)


# ---------------------------------------------------------------------
# CAUSE TYPE 3: Drainage failure (blocked/silted drains trap normal rain)
# ---------------------------------------------------------------------
def drainage_failure_severity(rainfall_mm: float, drainage_capacity_pct: float) -> float:
    """
    ASSUMPTION: Nullah Leh carries a constant baseline flow even with zero
    rainfall. Working drains carry it away; blocked drains let it back up
    and pool in low streets.

    IMPORTANT CALIBRATION NOTE: dry-day drain blockage causes LOCALISED
    street ponding, not regional flooding. BASELINE_FLOW_MM is therefore
    deliberately small (4mm) so a dry day with poor drains yields a low
    single-digit severity — a few percent of terrain near the channel —
    rather than a city-wide flood. Rainfall remains the dominant driver.
    """
    BASELINE_FLOW_MM = 4      # everyday channel flow the drains normally clear
    REFERENCE_MM = 90         # water volume equating to a severe flood

    blocked_fraction = 1 - (drainage_capacity_pct / 100)
    total_water_mm = BASELINE_FLOW_MM + rainfall_mm
    effective_mm = total_water_mm * blocked_fraction

    return min(100, (effective_mm / REFERENCE_MM) * 100)

# ---------------------------------------------------------------------
# CAUSE TYPE 4: Dam release (controlled/emergency release upstream)
# ---------------------------------------------------------------------
def dam_release_severity(release_intensity_pct: float) -> float:
    """
    ASSUMPTION: this is the most directly controllable cause — the
    operator's release intensity (0-100%) maps straight to severity.
    """
    return max(0, min(100, release_intensity_pct))


# ---------------------------------------------------------------------
# Core flood extent calculation — the "bathtub" itself
# ---------------------------------------------------------------------
def compute_flood_extent(water_level_m: float):
    """
    Returns (flooded_mask, stats_dict) for a given water level.
    flooded_mask is a boolean 2D array matching the DEM's shape.
    """
    elevation, valid = load_dem()
    flooded = elevation <= water_level_m

    valid_pixels = int(np.sum(~np.isnan(elevation)))
    flooded_pixels = int(np.sum(flooded))

    stats = {
        "water_level_m": water_level_m,
        "valid_pixels": valid_pixels,
        "flooded_pixels": flooded_pixels,
        "flooded_percent": round(100 * flooded_pixels / valid_pixels, 1),
    }
    return flooded, stats


def render_flood_png_base64(flooded_mask):
    """
    Turns the flooded boolean grid into a transparent blue PNG,
    ready to drape directly onto the map at the DEM's real coordinates.
    """
    height, width = flooded_mask.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)

    # Blue where flooded, fully transparent everywhere else
    rgba[flooded_mask] = [37, 99, 235, 170]  # R, G, B, alpha

    img = Image.fromarray(rgba, mode="RGBA")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"