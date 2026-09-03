"""
Verifies JSON mode is actually reliable with qwen/qwen3.6-27b on Groq
before building any retry loop around it -- per the build spec's
explicit instruction not to assume. Sends several REAL prompts shaped
like what the Hazard Analyst / Proposer will actually send (structured
extraction against real-shaped flood data), and checks each response
parses as valid JSON matching a simple expected shape.
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
from dotenv import load_dotenv
load_dotenv()

from groq import Groq

client = Groq(api_key=os.environ["GROQ_API_KEY"])
MODEL = "qwen/qwen3.6-27b"

PROMPTS = [
    # 1. Hazard-analyst-shaped: real-ish simulation stats -> priority zones
    """You are analyzing a REAL flood simulation result for the Nullah Leh /
Korang corridor. Identify 2-4 priority zones that most need prevention
action.

CRITICAL: only reference facility names that appear in the data below.
Never invent a name that isn't in this list.

Flooded area: 23.4%
Roads cut: 41
Affected facilities: [{"name": "Bilquis Memorial Hospital", "amenity": "hospital"}, {"name": "Al Ain International Specialist Eye Hospital", "amenity": "hospital"}]
Avg depth: 1.8m

Return ONLY valid JSON, this exact shape:
{"priority_zones": [{"description": "short real description", "bbox": [west, south, east, north], "affected_facility_names": ["must be from the real list above"]}]}""",

    # 2. Proposer-shaped: pick a candidate by id
    """You are proposing ONE prevention action from a fixed list of real
candidate points. Pick the candidate id that best addresses this
priority zone, and give length_m and reasoning.

Priority zone: "Dense residential cluster near Lai Nadi, 12 buildings at risk"
Candidates:
[{"id": 0, "descriptor": "On Lai Nadi", "lon": 73.0338, "lat": 33.6929}, {"id": 1, "descriptor": "On Lai Nadi", "lon": 73.0341, "lat": 33.6931}, {"id": 2, "descriptor": "On Korang Nullah", "lon": 73.0512, "lat": 33.7002}]

Return ONLY valid JSON, this exact shape:
{"candidate_id": 0, "parameters": {"length_m": 50, "height": 1.5}, "reasoning": "short real reasoning"}""",

    # 3. Retry-with-rejection-context shaped
    """Your previous proposal was rejected: "is only 7m from a road -- needs
at least 15m clearance". Pick a DIFFERENT candidate id from this list
that avoids that problem.

Candidates:
[{"id": 3, "descriptor": "On Lai Nadi", "lon": 73.0355, "lat": 33.6940}, {"id": 4, "descriptor": "On Lai Nadi", "lon": 73.0360, "lat": 33.6945}]

Return ONLY valid JSON: {"candidate_id": 3, "parameters": {"length_m": 40, "height": 1.5}, "reasoning": "short real reasoning"}""",

    # 4. Simple structured extraction, different domain flavor
    """Given this real flood scenario: cause_type=drainage_failure,
flooded_percent=15.2, roads_cut=18, avg_depth_m=0.9 -- classify the
severity as one of "low", "moderate", "high", "severe" and explain why
in one sentence.

Return ONLY valid JSON: {"severity": "moderate", "reasoning": "one sentence"}""",

    # 5. A prompt that tempts markdown-fencing (asks for "code")
    """Write a JSON object describing a retention pond prevention action
with fields: area_m2 (number), depth_m (number), reasoning (string).
Base it on a zone with heavy rainfall runoff. Format your answer as
JSON.""",

    # 6. Longer context, similar to what candidate lists will look like
    """Pick the best candidate_id from this list of 8 real waterway points
for a desilting action, given the zone description below.

Zone: "Silt buildup reported along a 200m stretch, reducing channel capacity"
Candidates: """ + json.dumps([
        {"id": i, "descriptor": f"On waterway segment {i}", "lon": 73.03 + i * 0.001, "lat": 33.69 + i * 0.0005}
        for i in range(8)
    ]) + """

Return ONLY valid JSON: {"candidate_id": 0, "parameters": {}, "reasoning": "short real reasoning"}""",
]


def strip_markdown_fences(text):
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.endswith("```"):
            t = t.rsplit("```", 1)[0]
    return t.strip()


def main():
    results = []
    for i, prompt in enumerate(PROMPTS, 1):
        t0 = time.time()
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0.3,
            )
            raw = response.choices[0].message.content
            elapsed = time.time() - t0
            had_fence = raw.strip().startswith("```")
            cleaned = strip_markdown_fences(raw)
            try:
                parsed = json.loads(cleaned)
                status = "VALID JSON" + (" (had markdown fence)" if had_fence else "")
            except json.JSONDecodeError as e:
                parsed = None
                status = f"INVALID JSON: {e}"
            results.append({"prompt_num": i, "status": status, "elapsed_s": round(elapsed, 2), "raw_len": len(raw)})
            print(f"\n{'=' * 70}\nPROMPT {i} -- {elapsed:.2f}s -- {status}")
            print(f"Raw response ({len(raw)} chars): {raw[:400]}")
            if parsed is not None:
                print(f"Parsed keys: {list(parsed.keys())}")
        except Exception as e:
            results.append({"prompt_num": i, "status": f"REQUEST FAILED: {e}", "elapsed_s": None})
            print(f"\n{'=' * 70}\nPROMPT {i} -- REQUEST FAILED: {e}")

    print(f"\n\n{'=' * 70}\nSUMMARY\n{'=' * 70}")
    valid_count = sum(1 for r in results if r["status"].startswith("VALID"))
    fenced_count = sum(1 for r in results if "fence" in r["status"])
    print(f"{valid_count}/{len(results)} valid JSON responses")
    print(f"{fenced_count}/{len(results)} wrapped in a markdown fence despite response_format=json_object")
    for r in results:
        print(f"  #{r['prompt_num']}: {r['status']}" + (f" ({r['elapsed_s']}s)" if r.get("elapsed_s") else ""))


if __name__ == "__main__":
    main()
