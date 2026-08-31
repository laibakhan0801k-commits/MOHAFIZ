from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
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

    return {"access_token": token, "token_type": "bearer"}


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

        # Calculate the real difference
        pixel_diff = before_stats['flooded_pixels'] - after_stats['flooded_pixels']
        area_saved_m2 = pixel_diff * flood_engine.PIXEL_AREA_M2
        roads_saved = before_roads['flooded_edge_count'] - after_roads['flooded_edge_count']

        return {
            "before": {
                "flooded_percent": before_stats['flooded_percent'],
                "flooded_pixels": before_stats['flooded_pixels'],
                "roads_cut": before_roads['flooded_edge_count'],
            },
            "after": {
                "flooded_percent": after_stats['flooded_percent'],
                "flooded_pixels": after_stats['flooded_pixels'],
                "roads_cut": after_roads['flooded_edge_count'],
            },
            "difference": {
                "percent_change": round(before_stats['flooded_percent'] - after_stats['flooded_percent'], 3),
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