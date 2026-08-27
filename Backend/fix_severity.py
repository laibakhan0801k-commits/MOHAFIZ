with open("flood_engine.py", encoding="utf-8") as f:
    content = f.read()

marker = "def severity_to_water_level(severity: float) -> float:"
start = content.find(marker)
end = content.find("\ndef ", start + 10)

old_function = content[start:end]
print("--- CURRENT FUNCTION ---")
print(old_function)
print("--- END ---")

new_function = """def severity_to_water_level(severity: float) -> float:
    severity = max(0, min(100, severity))
    _, valid = load_dem()
    if severity <= 0:
        return float(np.min(valid)) - 1.0
    return float(np.percentile(valid, severity))
"""

content = content[:start] + new_function + content[end:]

with open("flood_engine.py", "w", encoding="utf-8") as f:
    f.write(content)

print("DONE — function replaced")
