with open("flood_engine.py", encoding="utf-8") as f:
    content = f.read()

count = content.count("def severity_to_water_level")
print("Number of times severity_to_water_level is defined:", count)

print()
print("Has severity <= 0:", "severity <= 0" in content)
print("Has np.min(valid) - 1.0:", "np.min(valid) - 1.0" in content)

print()
print("--- Total file length (characters):", len(content))
print("--- Total lines:", len(content.splitlines()))

# Show every occurrence with surrounding context
import re
for m in re.finditer("def severity_to_water_level", content):
    idx = m.start()
    print()
    print("=== Occurrence at character", idx, "===")
    print(content[idx:idx+400])
