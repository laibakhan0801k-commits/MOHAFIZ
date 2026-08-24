from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import bcrypt
from jose import jwt
import os
import json
from dotenv import load_dotenv

from database import SessionLocal, User, Scenario
import flood_engine
import road_flooding

load_dotenv()
SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = "HS256"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
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
            severity = flood_engine.rainfall_severity(**request.params)
        elif request.cause_type == "river_overflow":
            severity = flood_engine.river_overflow_severity(**request.params)
        elif request.cause_type == "drainage_failure":
            severity = flood_engine.drainage_failure_severity(**request.params)
        elif request.cause_type == "dam_release":
            severity = flood_engine.dam_release_severity(**request.params)
        else:
            raise HTTPException(status_code=400, detail="Unknown cause_type")

        start_severity = max(3, severity * 0.15)
        frame_severities = [
            start_severity + (severity - start_severity) * (i / (FRAME_COUNT - 1))
            for i in range(FRAME_COUNT)
        ]

        frames = []
        for s in frame_severities:
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

        return {
            "scenario_id": scenario.id,
            "cause_type": request.cause_type,
            "severity": round(severity, 1),
            "water_level_m": water_level_m,
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
