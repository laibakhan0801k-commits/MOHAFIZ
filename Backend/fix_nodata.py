import re

# ---- FIX 1: road_flooding.py ----
with open("road_flooding.py", encoding="utf-8") as f:
    rf = f.read()

old_rf = """    node_flooded = {
        node_id: (elev <= water_level_m)
        for node_id, elev in zip(node_ids, elevations)
    }"""

new_rf = """    # DEM nodata pixels come back as large negative numbers (e.g. -32768).
    # Without this guard they always compare as "below water level" and get
    # falsely flagged as flooded even at zero severity.
    NODATA_FLOOR = -1000
    node_flooded = {
        node_id: (elev > NODATA_FLOOR and elev <= water_level_m)
        for node_id, elev in zip(node_ids, elevations)
    }"""

if old_rf in rf:
    rf = rf.replace(old_rf, new_rf)
    with open("road_flooding.py", "w", encoding="utf-8") as f:
        f.write(rf)
    print("FIX 1 (roads): applied")
else:
    print("FIX 1 (roads): pattern not found")

# ---- FIX 2 and 3: flood_engine.py ----
with open("flood_engine.py", encoding="utf-8") as f:
    fe = f.read()

old_b = """        elev = feature["properties"].get("base_elevation_m")
        if elev is not None and elev <= water_level_m:
            count += 1"""

new_b = """        elev = feature["properties"].get("base_elevation_m")
        # Guard against DEM nodata (large negative) being read as "underwater"
        if elev is not None and elev > -1000 and elev <= water_level_m:
            count += 1"""

if old_b in fe:
    fe = fe.replace(old_b, new_b)
    print("FIX 2 (buildings): applied")
else:
    print("FIX 2 (buildings): pattern not found")

old_f = """        elev = float(sampled[0][0])
        if elev <= water_level_m:"""

new_f = """        elev = float(sampled[0][0])
        # Guard against DEM nodata (large negative) being read as "underwater"
        if elev > -1000 and elev <= water_level_m:"""

if old_f in fe:
    fe = fe.replace(old_f, new_f)
    print("FIX 3 (facilities): applied")
else:
    print("FIX 3 (facilities): pattern not found")

with open("flood_engine.py", "w", encoding="utf-8") as f:
    f.write(fe)

print()
print("Verification:")
with open("road_flooding.py", encoding="utf-8") as f:
    print("  roads guard present:", "NODATA_FLOOR" in f.read())
with open("flood_engine.py", encoding="utf-8") as f:
    c = f.read()
    print("  buildings guard present:", "elev > -1000 and elev <= water_level_m" in c)
    print("  facilities guard present:", c.count("elev > -1000") >= 1)
