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

# This line actually creates the tables in Supabase if they don't exist yet
Base.metadata.create_all(bind=engine)
print("Users + Scenarios tables created (or already exist)")