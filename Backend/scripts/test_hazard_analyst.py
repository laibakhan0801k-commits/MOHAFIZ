"""
Standalone test for ai_hazard_analyst.py -- Part 3. Uses a REAL water
level (522m -- the same river_overflow bank_rise_m=1.0 scenario already
verified earlier this session via the actual /flood endpoint) to compute
REAL simulation stats, then runs the real Hazard Analyst LLM call
against them and confirms it never invents a facility name.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
load_dotenv()

import ai_hazard_analyst as HA

WATER_LEVEL_M = 522  # real, from the bank_rise_m=1.0 river_overflow run this session already verified


def main():
    print(f"Computing REAL simulation stats for water_level_m={WATER_LEVEL_M} "
          f"(same functions /flood and /prevention/simulate use)...\n")
    stats = HA.get_current_simulation_stats(WATER_LEVEL_M)
    print("Real simulation_stats:")
    for k, v in stats.items():
        if k == "affected_facilities":
            print(f"  {k}: {len(v)} facilities, e.g. {v[:3]}")
        else:
            print(f"  {k}: {v}")

    real_names = {f["name"] for f in stats["affected_facilities"]}
    print(f"\n{len(real_names)} real facility names available for the model to reference.\n")

    print("=" * 70)
    print("Running the real Hazard Analyst LLM call...")
    print("=" * 70)
    result = HA.run_hazard_analyst(stats)

    print(f"\n{len(result['priority_zones'])} priority zones returned:\n")
    all_names_real = True
    for i, zone in enumerate(result["priority_zones"]):
        print(f"Zone {i + 1}: {zone['description']}")
        print(f"  bbox: {zone['bbox']}")
        print(f"  affected_facility_names: {zone['affected_facility_names']}")
        for name in zone["affected_facility_names"]:
            if name not in real_names:
                all_names_real = False
                print(f"  !! HALLUCINATED NAME SLIPPED THROUGH: {name!r}")
        print()

    print("=" * 70)
    print(f"RESULT: {'PASS -- every referenced facility name is real' if all_names_real else 'FAIL -- a hallucinated name slipped through validate_hazard_response'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
