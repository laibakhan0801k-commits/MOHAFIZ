import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv()
db_url = os.getenv("DATABASE_URL")

engine = create_engine(db_url)

with engine.connect() as connection:
    result = connection.execute(text("SELECT version();"))
    print("Connected successfully!")
    print(result.fetchone())