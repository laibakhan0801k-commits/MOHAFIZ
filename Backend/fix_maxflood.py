with open("flood_engine.py", encoding="utf-8") as f:
    content = f.read()

marker = "def severity_to_water_level(severity: float) -> float:"
start = content.find(marker)
end = content.find("\ndef ", start + 10)

new_function = """def severity_to_water_level(severity: float) -> float:
    \"\"\"
    Convert a 0-100 severity score into a real water level in meters.

    severity=0  -> below the terrain minimum, so genuinely nothing floods.
    severity=100 -> capped at MAX_FLOOD_PERCENTILE, NOT the terrain's
    highest point. Real floods fill the low valley and city bowl; they do
    not submerge the Margalla foothills 250m above. Without this cap,
    maximum severity absurdly flooded 100% of terrain including mountains.
    \"\"\"
    MAX_FLOOD_PERCENTILE = 70

    severity = max(0, min(100, severity))
    _, valid = load_dem()

    if severity <= 0:
        return float(np.min(valid)) - 1.0

    effective_percentile = (severity / 100) * MAX_FLOOD_PERCENTILE
    return float(np.percentile(valid, effective_percentile))
"""

content = content[:start] + new_function + content[end:]

with open("flood_engine.py", "w", encoding="utf-8") as f:
    f.write(content)

print("Applied. Verifying:")
with open("flood_engine.py", encoding="utf-8") as f:
    c = f.read()
    print("  MAX_FLOOD_PERCENTILE present:", "MAX_FLOOD_PERCENTILE" in c)
    print("  zero-severity guard still present:", "severity <= 0" in c)
