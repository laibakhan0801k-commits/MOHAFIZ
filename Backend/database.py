import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, Column, String, DateTime, Float, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.sql import func
import uuid

load_dotenv()
db_url = os.getenv("DATABASE_URL")

engine = create_engine(db_url)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Scenario(Base):
    __tablename__ = "scenarios"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    cause_type = Column(String, nullable=False)  # rainfall / river_overflow / drainage_failure / dam_release
    input_params = Column(String, nullable=False)  # JSON string of the inputs used, e.g. {"intensity_mm_per_hr": 50}
    severity = Column(Float, nullable=False)
    water_level_m = Column(Float, nullable=False)
    flooded_percent = Column(Float, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SavedPlan(Base):
    __tablename__ = "saved_plans"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    plan_type = Column(String, nullable=False)  # "response" | "prevention"
    # JSON strings, same convention as Scenario.input_params above --
    # scenario_snapshot: whatever identifies the simulation run this plan
    # was built against (cause_type, water_level_m, params); actions:
    # the real placed markers/embankments/closedRoads at save time;
    # report_summary: the report/impact result shown when the user
    # generated it (Print/Download/Impact Report), so the saved entry
    # reflects what they actually saw, not a re-derived guess.
    scenario_snapshot = Column(String, nullable=False)
    actions = Column(String, nullable=False)
    report_summary = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

# This line actually creates the tables in Supabase if they don't exist yet
Base.metadata.create_all(bind=engine)
print("Users + Scenarios + SavedPlans tables created (or already exist)")