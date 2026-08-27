with open("main.py", encoding="utf-8") as f:
    content = f.read()

old = """        start_severity = max(3, severity * 0.15)"""

new = """        # Rainfall and drainage failure have a REAL water volume, so they use
        # the volume-conserving model. River overflow and dam release describe
        # a water LEVEL directly, so they keep the percentile mapping.
        if request.cause_type == "rainfall":
            raw_rain_mm = request.params["intensity_mm_per_hr"] * request.params["duration_hr"]
            use_volume_model = True
        elif request.cause_type == "drainage_failure":
            raw_rain_mm = 4 + request.params["rainfall_mm"]
            use_volume_model = True
        else:
            raw_rain_mm = 0
            use_volume_model = False

        start_severity = max(3, severity * 0.15)"""

if old in content:
    content = content.replace(old, new, 1)
    print("Step 1: volume routing added")
else:
    print("Step 1: pattern not found")

old2 = """        frames = []
        for s in frame_severities:
            wl = flood_engine.severity_to_water_level(s)"""

new2 = """        frames = []
        for s in frame_severities:
            if use_volume_model and severity > 0:
                frame_rain_mm = raw_rain_mm * (s / severity)
                wl = flood_engine.rainfall_to_water_level(frame_rain_mm)
            else:
                wl = flood_engine.severity_to_water_level(s)"""

if old2 in content:
    content = content.replace(old2, new2, 1)
    print("Step 2: frame generation updated")
else:
    print("Step 2: pattern not found")

old3 = """            "water_level_m": water_level_m,"""

new3 = """            "water_level_m": water_level_m,
            "avg_depth_m": flood_engine.compute_depth_stats(water_level_m)["avg_depth_m"],
            "max_depth_m": flood_engine.compute_depth_stats(water_level_m)["max_depth_m"],"""

if old3 in content:
    content = content.replace(old3, new3, 1)
    print("Step 3: depth stats added to response")
else:
    print("Step 3: pattern not found")

with open("main.py", "w", encoding="utf-8") as f:
    f.write(content)

print()
with open("main.py", encoding="utf-8") as f:
    c = f.read()
    print("use_volume_model present:", "use_volume_model" in c)
    print("avg_depth_m present:", "avg_depth_m" in c)
