import osmnx as ox

# Same locked bounding box
north, south = 33.7350, 33.6700
east, west = 73.0850, 73.0100
bbox = (west, south, east, north)

print("Downloading critical facilities (hospitals, clinics, schools, shelters)...")
facilities = ox.features_from_bbox(
    bbox,
    tags={
        "amenity": [
            "hospital",
            "clinic",
            "doctors",
            "pharmacy",
            "school",
            "college",
            "university",
            "police",
            "fire_station",
            "place_of_worship",
            "community_centre",
            "shelter",
        ]
    },
)
facilities.to_file("facilities.geojson", driver="GeoJSON")
print(f"Facilities saved: {len(facilities)} features")

# Count hospitals specifically — these matter most for rescue routing
hospitals = facilities[facilities["amenity"].isin(["hospital", "clinic", "doctors"])]
print(f"  of which hospitals/clinics: {len(hospitals)}")
for name in hospitals["name"].dropna().head(20):
    print(f"    - {name}")