from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import Optional
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import bcrypt
from jose import jwt
import os
import json
import math
import numpy as np
from dotenv import load_dotenv

from database import SessionLocal, User, Scenario
import flood_engine
import road_flooding
import routing

load_dotenv()
SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = "HS256"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class UserAuth(BaseModel):
    email: EmailStr
    password: str

class FloodRequest(BaseModel):
    cause_type: str
    params: dict
    user_id: str

class RouteRequest(BaseModel):
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    water_level_m: float
    # Roads the plan has closed by hand, as [u, v] graph node pairs taken
    # straight from roads.geojson. Optional so older callers still work.
    closed_edges: list[list[int]] | None = None


class DiversionCheckRequest(BaseModel):
    diversion_lat: float
    diversion_lon: float
    closure_u: int | None = None
    closure_v: int | None = None
    water_level_m: float
    closed_edges: list[list[int]] | None = None

@app.get("/")
def read_root():
    return {"message": "Mohafiz backend is running"}

@app.post("/signup")
def signup(user: UserAuth, db: Session = Depends(get_db)):
    existing_user = db.query(User).filter(User.email == user.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_password = bcrypt.hashpw(user.password.encode("utf-8"), bcrypt.gensalt())

    new_user = User(email=user.email, password_hash=hashed_password.decode("utf-8"))
    db.add(new_user)
    db.commit()

    return {"message": "Account created successfully"}

@app.post("/login")
def login(user: UserAuth, db: Session = Depends(get_db)):
    existing_user = db.query(User).filter(User.email == user.email).first()
    if not existing_user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    password_matches = bcrypt.checkpw(
        user.password.encode("utf-8"),
        existing_user.password_hash.encode("utf-8")
    )
    if not password_matches:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token_data = {
        "sub": existing_user.id,
        "exp": datetime.utcnow() + timedelta(days=7)
    }
    token = jwt.encode(token_data, SECRET_KEY, algorithm=ALGORITHM)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": existing_user.id,
        "email": existing_user.email,
    }


FRAME_COUNT = 6

@app.post("/flood")
def run_flood_scenario(request: FloodRequest, db: Session = Depends(get_db)):
    try:
        if request.cause_type == "rainfall":
            # Rainfall is selected as a PMD 24-hour accumulation band, not as
            # an intensity/duration pair. The band IS the severity input.
            severity = flood_engine.rainfall_band_severity(request.params.get("band"))
        elif request.cause_type == "river_overflow":
            severity = flood_engine.river_overflow_severity(**request.params)
        elif request.cause_type == "drainage_failure":
            severity = flood_engine.drainage_failure_severity(**request.params)
        elif request.cause_type == "dam_release":
            severity = flood_engine.dam_release_severity(**request.params)
        else:
            raise HTTPException(status_code=400, detail="Unknown cause_type")

        # Rainfall and drainage failure have a REAL water volume, so they use
        # the volume-conserving model. River overflow and dam release describe
        # a water LEVEL directly, so they keep the percentile mapping.
        if request.cause_type == "rainfall":
            raw_rain_mm = flood_engine.rainfall_band_plan_mm(request.params.get("band"))
            use_volume_model = True
        elif request.cause_type == "drainage_failure":
            raw_rain_mm = 4 + request.params["rainfall_mm"]
            use_volume_model = True
        else:
            raw_rain_mm = 0
            use_volume_model = False

        start_severity = max(3, severity * 0.15)
        frame_severities = [
            start_severity + (severity - start_severity) * (i / (FRAME_COUNT - 1))
            for i in range(FRAME_COUNT)
        ]

        frames = []
        for s in frame_severities:
            if use_volume_model and severity > 0:
                frame_rain_mm = raw_rain_mm * (s / severity)
                wl = flood_engine.rainfall_to_water_level(frame_rain_mm)
            else:
                wl = flood_engine.severity_to_water_level(s)
            mask, stats = flood_engine.compute_flood_extent(wl)
            img = flood_engine.render_flood_png_base64(mask)
            frames.append({
                "severity": round(s, 1),
                "water_level_m": round(wl, 1),
                "flooded_percent": stats["flooded_percent"],
                "flood_image": img,
            })

        final = frames[-1]
        water_level_m = final["water_level_m"]

        final_mask, _ = flood_engine.compute_flood_extent(water_level_m)
        flooded_bbox = flood_engine.get_flooded_bbox(final_mask)

        road_result = road_flooding.get_flooded_roads(water_level_m)
        west, south, east, north = flood_engine.get_dem_bounds()

        affected_building_count = flood_engine.count_affected_buildings(water_level_m)
        affected_facilities = flood_engine.list_affected_facilities(water_level_m)

        scenario = Scenario(
            user_id=request.user_id,
            cause_type=request.cause_type,
            input_params=json.dumps(request.params),
            severity=severity,
            water_level_m=water_level_m,
            flooded_percent=final["flooded_percent"],
        )
        db.add(scenario)
        db.commit()
        db.refresh(scenario)

        rainfall_band_info = None
        if request.cause_type == "rainfall":
            band_key = request.params.get("band")
            record = flood_engine.rainfall_band(band_key)
            rainfall_band_info = {
                "band": band_key,
                "label": record["label"],
                "range_label": record["range_label"],
                "plan_mm": record["plan_mm"],
                "order": record["order"],
            }

        return {
            "scenario_id": scenario.id,
            "cause_type": request.cause_type,
            "rainfall_band": rainfall_band_info,
            "severity": round(severity, 1),
            "water_level_m": water_level_m,
            "avg_depth_m": flood_engine.compute_depth_stats(water_level_m)["avg_depth_m"],
            "max_depth_m": flood_engine.compute_depth_stats(water_level_m)["max_depth_m"],
            "water_depth_m": round(max(0, water_level_m - float(flood_engine.load_dem()[1].min())), 1),
            "flooded_percent": final["flooded_percent"],
            "flood_image": final["flood_image"],
            "flood_image_bounds": [west, south, east, north],
            "flooded_bbox": flooded_bbox,
            "flooded_road_count": road_result["flooded_edge_count"],
            "clear_road_count": road_result["clear_edge_count"],
            "flooded_roads": [e["coords"] for e in road_result["flooded_edges"]],
            "affected_building_count": affected_building_count,
            "affected_facilities": affected_facilities,
            "frames": frames,
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(e).__name__) + ": " + str(e) + " | " + traceback.format_exc()[-500:])


@app.post("/diversion-check")
def diversion_check(request: DiversionCheckRequest):
    """
    Whether a traffic diversion point sits where it can actually work:
    upstream of the closure it serves, and with a way round from there.
    Answers on the real directed road network, so one-way streets count.
    """
    try:
        return routing.check_diversion(
            request.diversion_lat,
            request.diversion_lon,
            request.closure_u,
            request.closure_v,
            request.water_level_m,
            routing.normalise_closures(request.closed_edges),
        )
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(e).__name__) + ": " + str(e) + " | " + traceback.format_exc()[-500:])


class EmbankmentCompareRequest(BaseModel):
    line_coords: list[list[float]]
    height_m: float
    water_level_m: float


@app.post("/embankment-compare")
def compare_embankment(request: EmbankmentCompareRequest):
    """
    Runs the real flood physics BEFORE and AFTER applying an embankment
    to the terrain. Returns both sets of stats so the frontend can show
    the real difference, not a fake percentage.
    """
    try:
        elevation, valid = flood_engine.load_dem()
        bounds = flood_engine.get_dem_bounds()

        # BEFORE: real terrain, no intervention
        before_mask, before_stats = flood_engine.compute_flood_extent_on_array(
            elevation, request.water_level_m
        )
        before_roads = road_flooding.get_flooded_roads_on_array(
            request.water_level_m, elevation, bounds
        )

        # Apply the embankment: raise terrain along the line by height_m
        modified_elevation = flood_engine.apply_line_raise(
            elevation, bounds, request.line_coords, request.height_m
        )

        # AFTER: same water level, modified terrain
        after_mask, after_stats = flood_engine.compute_flood_extent_on_array(
            modified_elevation, request.water_level_m
        )
        after_roads = road_flooding.get_flooded_roads_on_array(
            request.water_level_m, modified_elevation, bounds
        )

        before_out = {
            "flooded_percent": before_stats['flooded_percent'],
            "flooded_pixels": before_stats['flooded_pixels'],
            "roads_cut": before_roads['flooded_edge_count'],
        }
        after_out = {
            "flooded_percent": after_stats['flooded_percent'],
            "flooded_pixels": after_stats['flooded_pixels'],
            "roads_cut": after_roads['flooded_edge_count'],
        }
        # Same hard invariant as the main prevention simulation — see
        # _clamp_after_stats. An embankment only ever raises terrain, so
        # this should never fire, but it shares the one clamp function
        # rather than duplicating (unpatched) safety logic per endpoint.
        _clamp_after_stats(before_out, after_out)

        pixel_diff = max(0, before_out['flooded_pixels'] - after_out['flooded_pixels'])
        roads_saved = max(0, before_out['roads_cut'] - after_out['roads_cut'])
        area_saved_m2 = pixel_diff * flood_engine.PIXEL_AREA_M2

        return {
            "before": before_out,
            "after": after_out,
            "difference": {
                "percent_change": max(0.0, round(before_out['flooded_percent'] - after_out['flooded_percent'], 3)),
                "pixels_saved": pixel_diff,
                "area_saved_m2": round(area_saved_m2, 0),
                "roads_saved": roads_saved,
            },
        }
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(e).__name__) + ": " + str(e) + " | " + traceback.format_exc()[-500:])


class FloodDepthGridRequest(BaseModel):
    water_level_m: float


@app.post("/flood-depth-grid")
def flood_depth_grid(request: FloodDepthGridRequest):
    """
    Real per-cell water depth for the water level of a simulation that has
    ALREADY been run. This is the same bathtub flood extent the map overlay
    is drawn from, exposed as depth numbers so the response planner can ask
    "how deep is the water at this exact point?" — needed because response
    actions turn on real thresholds (a road under 5cm is still passable, one
    under 60cm is not) that a boolean flooded/not-flooded mask cannot answer.

    Depths are returned as whole CENTIMETRES to keep the payload small:
      >= 0  water depth in cm at that cell
      -1    DEM has no data for that cell
    Row-major, `width` values per row, starting at the north-west corner.
    """
    try:
        depth, meta = flood_engine.compute_depth_grid(request.water_level_m)

        depth_cm = np.where(np.isnan(depth), -1, np.round(depth * 100))
        meta["depth_cm"] = depth_cm.astype(np.int32).ravel().tolist()

        # Real ground size of one cell, so the frontend can reason about how
        # coarse this grid is instead of pretending it is point-accurate.
        west, south, east, north = meta["bounds"]
        lat_mid = (north + south) / 2
        meta["cell_width_m"] = round((east - west) / meta["width"] * 111320 * math.cos(math.radians(lat_mid)), 1)
        meta["cell_height_m"] = round((north - south) / meta["height"] * 111320, 1)

        return meta
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(e).__name__) + ": " + str(e) + " | " + traceback.format_exc()[-500:])


# ---------------------------------------------------------------------
# Prevention simulation — shared helpers and models
# ---------------------------------------------------------------------
import math as _math

def _resolve_water_level(cause_type, params, runoff_coefficient=0.6):
    """Shared dispatch: cause_type + params → (severity, water_level_m).
    Used by both /flood and /prevention/simulate so they stay identical."""
    if cause_type == "rainfall":
        severity = flood_engine.rainfall_severity(**params)
        raw_rain_mm = params["intensity_mm_per_hr"] * params["duration_hr"]
        water_level = flood_engine.rainfall_to_water_level(raw_rain_mm, runoff_coefficient) if severity > 0 else float(flood_engine.load_dem()[1].min()) - 1.0
    elif cause_type == "drainage_failure":
        severity = flood_engine.drainage_failure_severity(**params)
        raw_rain_mm = 4 + params["rainfall_mm"]
        water_level = flood_engine.rainfall_to_water_level(raw_rain_mm, runoff_coefficient) if severity > 0 else float(flood_engine.load_dem()[1].min()) - 1.0
    elif cause_type == "river_overflow":
        severity = flood_engine.river_overflow_severity(**params)
        water_level = flood_engine.severity_to_water_level(severity)
    elif cause_type == "dam_release":
        severity = flood_engine.dam_release_severity(**params)
        water_level = flood_engine.severity_to_water_level(severity)
    else:
        raise HTTPException(status_code=400, detail="Unknown cause_type: " + cause_type)
    return severity, water_level


class PreventionAction(BaseModel):
    uid: int = 0
    type: str
    lat: float = None
    lon: float = None
    params: dict = {}
    line_coords: list = None
    target_waterway_id: int = None


class PreventionSimulateRequest(BaseModel):
    cause_type: str
    params: dict
    water_level_m: Optional[float] = None
    actions: list


def _build_terrain_args(actions):
    """Group prevention actions into terrain-modification categories
    for apply_all_terrain_actions."""
    embankments = []
    ponds = []
    widen_actions = []
    encroachments = []
    capacity_actions = []

    for a in actions:
        atype = a.get("type", "") if isinstance(a, dict) else getattr(a, "type", "")
        params = a.get("params", {}) if isinstance(a, dict) else getattr(a, "params", {})
        lat = a.get("lat") if isinstance(a, dict) else getattr(a, "lat", None)
        lon = a.get("lon") if isinstance(a, dict) else getattr(a, "lon", None)
        uid = a.get("uid", 0) if isinstance(a, dict) else getattr(a, "uid", 0)
        line_coords = a.get("line_coords") if isinstance(a, dict) else getattr(a, "line_coords", None)
        twid = a.get("target_waterway_id") if isinstance(a, dict) else getattr(a, "target_waterway_id", None)

        if atype == "embankment":
            height = float(params.get("height", 1.5))
            if line_coords:
                embankments.append({"line_coords": line_coords, "height_m": height, "uid": uid})
        elif atype == "retentionPond":
            area = float(params.get("surface_area_m2") or params.get("area", 2000))
            depth = float(params.get("depth_m") or params.get("depth", 2))
            radius = _math.sqrt(area / _math.pi)
            ponds.append({"lon": lon, "lat": lat, "radius_m": radius, "depth_m": depth, "uid": uid})
        elif atype == "widenChannel":
            new_width = float(params.get("new_width_m") or params.get("newWidth", 8))
            length = float(params.get("section_length_m") or params.get("length", 50))
            depth_m = 0.5
            if line_coords:
                widen_actions.append({"line_coords": line_coords, "depth_m": depth_m,
                                       "buffer_m": new_width / 2, "uid": uid})
            elif lon is not None and lat is not None:
                half_deg = (length / 2) / 111320
                synthetic_line = [[lon, lat - half_deg], [lon, lat + half_deg]]
                widen_actions.append({"line_coords": synthetic_line, "depth_m": depth_m,
                                       "buffer_m": new_width / 2, "uid": uid})
        elif atype == "removeEncroachment":
            encroachments.append({"lon": lon, "lat": lat, "radius_m": 7, "depth_m": 2, "uid": uid})
        elif atype in ("desilt", "clearDrains", "greenBuffer"):
            capacity_actions.append({"type": atype, "params": params,
                                      "target_waterway_id": twid, "uid": uid})

    return embankments, ponds, widen_actions, encroachments, capacity_actions


_CLAMPED_METRICS = ("flooded_percent", "flooded_pixels", "roads_cut", "buildings_affected", "avg_depth_m", "max_depth_m")


def _clamp_after_stats(before_stats, after_stats):
    """
    Hard invariant, applied at the data layer everywhere a before/after
    flood comparison is returned (prevention simulate/breakdown AND the
    embankment sidebar preview) — a plan must never look like it made
    things worse than doing nothing. Structural volume reduction, capacity
    gain and local protection are all non-negative by construction, so
    this should never actually trigger — but if a future change or a
    floating-point edge case ever pushes an "after" metric above its
    "before" baseline, clamp it back to the baseline (zero improvement,
    not a negative one) and log it loudly instead of silently showing a
    misleading regression to the user.

    Only clamps keys present in BOTH dicts, so the same helper works for
    the full prevention-sim stats and the smaller embankment-compare
    stats without needing two copies of this logic.
    """
    for key in _CLAMPED_METRICS:
        if key not in before_stats or key not in after_stats:
            continue
        if after_stats[key] > before_stats[key]:
            print(f"WARNING: flood-comparison after.{key}={after_stats[key]} exceeded "
                  f"before.{key}={before_stats[key]} — clamping to baseline. "
                  f"This should not happen; investigate the physics if it does.")
            after_stats[key] = before_stats[key]
    return after_stats


def _run_prevention_sim(cause_type, params, actions, elevation, bounds, direct_water_level_m=None):
    """Core simulation: returns (before_stats, after_stats, images, capacity_meta).
    Shared by /prevention/simulate and /prevention/breakdown.
    If direct_water_level_m is provided, use it instead of computing from params."""
    embankments, ponds, widen_actions, encroachments, capacity_actions = _build_terrain_args(actions)

    # Compute volume reduction from structural interventions (ponds, widening,
    # encroachment removal). These intercept or convey away flood volume before
    # it spreads across the floodplain — real Manning/storage physics.
    structural_vol_m3 = flood_engine.compute_structural_volume_reduction(
        ponds, widen_actions, encroachments, cause_type=cause_type
    )

    # Level-driven causes (river overflow / dam release) don't have a real
    # rainfall volume this DEM can "own" — the water is arriving from far
    # upstream, so a single pond or widened channel section genuinely
    # cannot lower the WHOLE river's flood stage. Diluting its intercepted
    # volume across the entire study area (as volume-based causes correctly
    # do) made every structural action look like it did nothing — a few
    # thousand m3 against a basin holding millions is a rounding error.
    # What a local measure CAN honestly do is protect its own immediate
    # surroundings, so for these causes we keep the basin-wide water level
    # unchanged and apply the intercepted volume as a local protection zone
    # instead (flood_engine.apply_local_protection).
    level_driven = cause_type in ("river_overflow", "dam_release")

    if direct_water_level_m is not None:
        wl_before = direct_water_level_m
        capacity_meta = flood_engine.compute_capacity_gain(capacity_actions, cause_type=cause_type)
        if capacity_meta["applies_to_cause"]:
            # Volume-based causes: structural interception competes with the
            # same catchment-wide runoff volume the water level came from —
            # solving for a new basin-wide equilibrium level is the honest
            # model here.
            vol_before = flood_engine.volume_stored_below(wl_before)
            vol_after = max(0.0, vol_before - structural_vol_m3)
            rc_after = capacity_meta["runoff_coefficient_after"]
            vol_after = vol_after * (rc_after / 0.6)
            wl_after = flood_engine.water_level_from_volume(vol_after) if vol_after > 0 else float(elevation.min()) - 1.0
        else:
            wl_after = wl_before
        severity_before = 1 if wl_before > float(elevation.min()) else 0
        severity_after = 1 if wl_after > float(elevation.min()) else 0
    else:
        try:
            severity_before, wl_before = _resolve_water_level(cause_type, params, 0.6)
        except (TypeError, KeyError):
            severity_before, wl_before = 1, flood_engine.severity_to_water_level(50)
        capacity_meta = flood_engine.compute_capacity_gain(capacity_actions, cause_type=cause_type)
        if capacity_meta["applies_to_cause"]:
            rc_after = capacity_meta["runoff_coefficient_after"]
            # Subtract structural volume from the before-volume, then scale by
            # runoff coefficient change from capacity actions.
            vol_before = flood_engine.volume_stored_below(wl_before)
            vol_after = max(0.0, vol_before - structural_vol_m3) * (rc_after / 0.6)
            try:
                if vol_after <= 0:
                    severity_after = 0
                    wl_after = float(flood_engine.load_dem()[1].min()) - 1.0
                else:
                    wl_after = flood_engine.water_level_from_volume(vol_after)
                    severity_after = severity_before
            except (TypeError, KeyError):
                severity_after, wl_after = 1, flood_engine.severity_to_water_level(50)
        else:
            severity_after, wl_after = severity_before, wl_before

    before_mask, before_flood = flood_engine.compute_flood_extent_on_array(elevation, wl_before)
    before_roads = road_flooding.get_flooded_roads_on_array(wl_before, elevation, bounds)
    before_buildings = flood_engine.count_affected_buildings_on_array(elevation, bounds, wl_before)
    before_depth = flood_engine.compute_depth_stats_on_array(elevation, wl_before)

    modified, terrain_meta = flood_engine.apply_all_terrain_actions(
        elevation, bounds, embankments, ponds, widen_actions, encroachments
    )
    # Raw numpy array — used internally below, must not leak into the
    # JSON response (terrain_meta is returned as-is to the frontend).
    engineered_mask = terrain_meta.pop('engineered_mask')

    local_protection_m3 = 0.0
    if level_driven:
        protection = flood_engine.apply_local_protection(elevation, bounds, ponds, widen_actions, encroachments)
        if protection.any():
            modified = modified + protection
            local_protection_m3 = structural_vol_m3

    # A pond/widened channel/restored-channel footprint holds water BY
    # DESIGN — that's the measure working, not storm damage. Excluded here
    # so digging one doesn't make the plan look like it flooded more area.
    after_calc = flood_engine.exclude_engineered_footprint(modified, engineered_mask)

    after_mask, after_flood = flood_engine.compute_flood_extent_on_array(after_calc, wl_after)
    after_roads = road_flooding.get_flooded_roads_on_array(wl_after, after_calc, bounds)
    after_buildings = flood_engine.count_affected_buildings_on_array(after_calc, bounds, wl_after)
    after_depth = flood_engine.compute_depth_stats_on_array(after_calc, wl_after)

    before_img = flood_engine.render_flood_png_base64(before_mask)
    after_img = flood_engine.render_flood_comparison_png_base64(before_mask, after_mask)

    before_stats = {
        "flooded_percent": before_flood["flooded_percent"],
        "flooded_pixels": before_flood["flooded_pixels"],
        "roads_cut": before_roads["flooded_edge_count"],
        "buildings_affected": before_buildings,
        "avg_depth_m": before_depth["avg_depth_m"],
        "max_depth_m": before_depth["max_depth_m"],
        "water_level_m": round(wl_before, 2),
        # Real bounding box of the flooded area (not the whole DEM) — lets
        # the frontend frame the before/after thumbnails around the actual
        # flood shape instead of zooming to wherever the actions happen to
        # sit, which can crop into one uniformly-flooded patch and look
        # like a solid color block. after_mask is always a subset of
        # before_mask (see _clamp_after_stats), so before's bbox already
        # covers both.
        "flooded_bbox": flood_engine.get_flooded_bbox(before_mask),
    }
    after_stats = {
        "flooded_percent": after_flood["flooded_percent"],
        "flooded_pixels": after_flood["flooded_pixels"],
        "roads_cut": after_roads["flooded_edge_count"],
        "buildings_affected": after_buildings,
        "avg_depth_m": after_depth["avg_depth_m"],
        "max_depth_m": after_depth["max_depth_m"],
    }
    _clamp_after_stats(before_stats, after_stats)

    pixels_saved = max(0, before_stats["flooded_pixels"] - after_stats["flooded_pixels"])
    after_stats.update({
        "water_level_m": round(wl_after, 2),
        "water_level_saved_m": round(max(0.0, wl_before - wl_after), 3),
        "volume_stored_m3": round(structural_vol_m3, 0),
        "locally_protected_m3": round(local_protection_m3, 0),
        "pixels_saved": pixels_saved,
        "area_saved_m2": round(pixels_saved * flood_engine.PIXEL_AREA_M2, 0),
    })

    return before_stats, after_stats, before_img, after_img, capacity_meta, terrain_meta, structural_vol_m3


@app.post("/prevention/simulate")
def prevention_simulate(request: PreventionSimulateRequest):
    """Combined before/after simulation of all prevention actions.
    Runs the real flood physics on unmodified terrain (BEFORE) and on
    terrain modified by every placed action (AFTER)."""
    try:
        elevation, valid = flood_engine.load_dem()
        bounds = flood_engine.get_dem_bounds()
        w, s, e, n = bounds

        before, after, before_img, after_img, capacity, terrain, struct_vol = _run_prevention_sim(
            request.cause_type, request.params, request.actions, elevation, bounds,
            direct_water_level_m=request.water_level_m
        )

        # Never show a plan as making things worse — see _clamp_after_stats.
        delta_pct = max(0.0, round(before["flooded_percent"] - after["flooded_percent"], 2))
        roads_saved = max(0, before["roads_cut"] - after["roads_cut"])
        buildings_saved = max(0, before["buildings_affected"] - after["buildings_affected"])

        return {
            "before": before,
            "after": after,
            "difference": {
                "flooded_percent_change": delta_pct,
                "roads_saved": roads_saved,
                "buildings_saved": buildings_saved,
                "water_level_saved_m": after["water_level_saved_m"],
                "volume_stored_m3": after["volume_stored_m3"],
                "locally_protected_m3": after["locally_protected_m3"],
                "pixels_saved": after["pixels_saved"],
                "area_saved_m2": after["area_saved_m2"],
            },
            "flood_image_before": before_img,
            "flood_image_after": after_img,
            "flood_image_bounds": [w, s, e, n],
            "capacity": capacity,
            "terrain_meta": terrain,
        }
    except HTTPException:
        raise
    except Exception as ex:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(ex).__name__) + ": " + str(ex) + " | " + traceback.format_exc()[-500:])


_HONESTY_TIERS = {
    'embankment': 'Simulated',
    'retentionPond': 'Simulated',
    'widenChannel': 'Simulated (simplified geometry)',
    'removeEncroachment': 'Simulated — effect is small at this map\u2019s resolution',
    'desilt': 'Calculated (simplified model)',
    'clearDrains': 'Calculated (simplified model)',
    'greenBuffer': 'Calculated (simplified model)',
    'warningGauge': 'Preparedness measure \u2014 no modelled flood reduction',
}


@app.post("/prevention/breakdown")
def prevention_breakdown(request: PreventionSimulateRequest):
    """Leave-one-out per-action breakdown. Runs N+1 simulations:
    1 baseline with all actions, then N runs each missing one action.
    The marginal contribution of each action is the difference between
    the without-it run and the full run."""
    try:
        actions = request.actions
        if len(actions) > 25:
            raise HTTPException(status_code=400,
                                detail="Breakdown supports up to 25 actions")

        elevation, valid = flood_engine.load_dem()
        bounds = flood_engine.get_dem_bounds()

        full_before, full_after, _, _, full_capacity, full_terrain, full_struct_vol = _run_prevention_sim(
            request.cause_type, request.params, actions, elevation, bounds,
            direct_water_level_m=request.water_level_m
        )

        # Never show the combined plan as making things worse — see _clamp_after_stats.
        total_delta_pct = max(0.0, full_before["flooded_percent"] - full_after["flooded_percent"])
        total_roads_saved = max(0, full_before["roads_cut"] - full_after["roads_cut"])
        total_buildings_saved = max(0, full_before["buildings_affected"] - full_after["buildings_affected"])

        breakdown = []
        sum_delta_pct = 0.0
        sum_roads_saved = 0
        sum_buildings_saved = 0

        for i, action in enumerate(actions):
            atype = action.get("type", "") if isinstance(action, dict) else getattr(action, "type", "")
            params = action.get("params", {}) if isinstance(action, dict) else getattr(action, "params", {})

            reduced = actions[:i] + actions[i+1:]
            _, without_after, _, _, _, _, _ = _run_prevention_sim(
                request.cause_type, request.params, reduced, elevation, bounds,
                direct_water_level_m=request.water_level_m
            )

            delta_pct = without_after["flooded_percent"] - full_after["flooded_percent"]
            roads_saved = without_after["roads_cut"] - full_after["roads_cut"]
            buildings_saved = without_after["buildings_affected"] - full_after["buildings_affected"]
            pixels_saved = max(0, without_after["flooded_pixels"] - full_after["flooded_pixels"])
            sum_delta_pct += delta_pct
            sum_roads_saved += roads_saved
            sum_buildings_saved += buildings_saved

            # Per-action structural volume: simulate with only this action
            _, single_after, _, _, _, _, single_vol = _run_prevention_sim(
                request.cause_type, request.params, [action], elevation, bounds,
                direct_water_level_m=request.water_level_m
            )

            is_subpixel = any(
                sp.get("uid") == (action.get("uid", 0) if isinstance(action, dict) else getattr(action, "uid", 0))
                for sp in full_terrain.get("subpixel_actions", [])
            )

            note = None
            if atype == "warningGauge":
                delta_pct = 0
                roads_saved = 0
                buildings_saved = 0
                note = "Flood alert sensors save lives but don't reduce flood extent."
            elif atype in ("desilt", "clearDrains", "greenBuffer"):
                if not full_capacity.get("applies_to_cause"):
                    note = "Capacity actions have no modelled effect for " + request.cause_type + " scenarios."

            breakdown.append({
                "type": atype,
                "params": params,
                "honesty_tier": _HONESTY_TIERS.get(atype, "Simulated"),
                "delta_flooded_percent": round(delta_pct, 3),
                "roads_saved": roads_saved,
                "buildings_saved": buildings_saved,
                "is_subpixel": is_subpixel,
                "note": note,
                "volume_stored_m3": round(single_vol, 0),
                "water_level_saved_m": round(single_after["water_level_saved_m"], 3),
                "locally_protected_m3": single_after["locally_protected_m3"],
                "pixels_saved": pixels_saved,
                "area_saved_m2": round(pixels_saved * flood_engine.PIXEL_AREA_M2, 0),
            })

        interaction_note = None
        if abs(sum_delta_pct - total_delta_pct) > 0.01:
            interaction_note = (
                "Individual contributions don't sum to the total because some "
                "actions overlap. This is correct — overlapping measures share "
                "the same protected pixels."
            )

        return {
            "total_effect": {
                "flooded_percent_change": round(total_delta_pct, 2),
                "roads_saved": total_roads_saved,
                "buildings_saved": total_buildings_saved,
                "water_level_saved_m": full_after["water_level_saved_m"],
                "volume_stored_m3": full_after["volume_stored_m3"],
                "locally_protected_m3": full_after["locally_protected_m3"],
                "pixels_saved": full_after["pixels_saved"],
                "area_saved_m2": full_after["area_saved_m2"],
            },
            "sum_of_marginals": {
                "flooded_percent_change": round(sum_delta_pct, 3),
                "roads_saved": sum_roads_saved,
                "buildings_saved": sum_buildings_saved,
            },
            "interaction_note": interaction_note,
            "per_action_breakdown": breakdown,
        }
    except HTTPException:
        raise
    except Exception as ex:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(ex).__name__) + ": " + str(ex) + " | " + traceback.format_exc()[-500:])


@app.post("/route")
def get_route(request: RouteRequest):
    try:
        direct = routing.find_route(request.start_lat, request.start_lon, request.end_lat, request.end_lon)

        # No road connection at all, flooding aside. Answered explicitly so
        # the caller can say WHY it is unreachable instead of guessing.
        if not direct.get("reachable", True):
            return {
                "direct_route": [],
                "direct_length_m": 0,
                "crosses_flood": False,
                "reachable": False,
                "safe_route": None,
                "safe_length_m": None,
                "unreachable_reason": "no_road_connection",
                "water_level_m": request.water_level_m,
            }

        closed_pairs = routing.normalise_closures(request.closed_edges)

        crosses = routing.route_crosses_flood(direct, request.water_level_m)
        hits_closure = routing.route_crosses_closures(direct, closed_pairs)

        # The DIRECT route stays the untouched baseline — it shows what you
        # would drive if neither the flood nor the closures existed. Only the
        # safe route routes around them.
        if crosses or hits_closure:
            safe = routing.find_flood_safe_route(
                request.start_lat, request.start_lon,
                request.end_lat, request.end_lon,
                request.water_level_m,
                closed_pairs,
            )
        else:
            safe = direct

        reachable = safe.get("reachable", True)

        # Self-check: the returned safe route must not traverse a closed
        # edge. Answered on the node path, which is the only thing that
        # actually settles it.
        safe_hits_closure = reachable and routing.route_crosses_closures(safe, closed_pairs)

        if reachable:
            unreachable_reason = None
        elif closed_pairs and not crosses:
            unreachable_reason = "cut_off_by_closures"
        elif closed_pairs:
            unreachable_reason = "cut_off_by_flood_and_closures"
        else:
            unreachable_reason = "cut_off_by_flood"

        return {
            "direct_route": direct["coords"],
            "direct_length_m": direct["length_m"],
            "crosses_flood": crosses,
            "crosses_closures": hits_closure,
            "safe_crosses_closures": safe_hits_closure,
            "closures_applied": len(closed_pairs) // 2,
            "reachable": reachable,
            "safe_route": safe["coords"] if reachable else None,
            "safe_length_m": safe.get("length_m") if reachable else None,
            "unreachable_reason": unreachable_reason,
            # Echoed back so the frontend can prove a drawn route belongs to
            # the water level it is currently displaying.
            "water_level_m": request.water_level_m,
        }
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=str(type(e).__name__) + ": " + str(e) + " | " + traceback.format_exc()[-500:])