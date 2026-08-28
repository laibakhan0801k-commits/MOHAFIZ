with open("flood_engine.py", encoding="utf-8") as f:
    content = f.read()

if "THRESHOLD_MM = 25" in content:
    content = content.replace("THRESHOLD_MM = 25", "THRESHOLD_MM = 15", 1)
    with open("flood_engine.py", "w", encoding="utf-8") as f:
        f.write(content)
    print("Applied: THRESHOLD_MM 25 -> 15")
else:
    print("THRESHOLD_MM = 25 not found")

import re
with open("flood_engine.py", encoding="utf-8") as f:
    m = re.search(r"THRESHOLD_MM = (\d+)", f.read())
    print("Now:", m.group(1) if m else "not found")
