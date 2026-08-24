from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import bcrypt
from jose import jwt
import os
from dotenv import load_dotenv

from database import SessionLocal, User

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

# This gives each request its own database session, and closes it when done
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Defines what a signup/login request must look like
class UserAuth(BaseModel):
    email: EmailStr
    password: str

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