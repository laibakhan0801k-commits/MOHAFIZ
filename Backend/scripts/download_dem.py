import os
import requests
from dotenv import load_dotenv

load_dotenv()
api_key = os.getenv("OPENTOPO_API_KEY")

# Same bounding box as our roads/buildings download
north, south = 33.7350, 33.6700
east, west = 73.0850, 73.0100

url = "https://portal.opentopography.org/API/globaldem"
params = {
    "demtype": "SRTMGL1",       # SRTM elevation data, ~30m resolution
    "south": south,
    "north": north,
    "west": west,
    "east": east,
    "outputFormat": "GTiff",     # a standard elevation file format
    "API_Key": api_key,
}

print("Downloading elevation data... this may take a minute")
response = requests.get(url, params=params)

if response.status_code == 200:
    with open("elevation.tif", "wb") as f:
        f.write(response.content)
    print("Elevation data saved to elevation.tif")
else:
    print(f"Failed. Status code: {response.status_code}")
    print(response.text)