"""
Standalone test for ai_response_strategist.py -- Part 2. Runs the real
Hazard Reader (Part 1) to get real uncovered zones, then the real
Strategist agentic loop against them, printing every accepted
proposal's real validated_payload and real_coverage -- same discipline
as test_ai_proposer.py. Kept to max_proposals=2 to go easy on the Groq
daily quota.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
load_dotenv()

import ai_hazard_analyst as HA
import ai_response_hazard_reader as HR
import ai_response_strategist as STRAT
import prevention_validation as PV
import response_validation as RV

WATER_LEVEL_M = 553  # matches the real severe scenario used in the frontend screenshot check
CAUSE_TYPE = "river_overflow"


def main():
    print(f"Computing REAL simulation stats for water_level_m={WATER_LEVEL_M}...")
    stats = HA.get_current_simulation_stats(WATER_LEVEL_M)
    print(f"  flooded_percent={stats['flooded_percent']}%, roads_cut={stats['roads_cut']}, "
          f"buildings_affected={stats['buildings_affected']}\n")

    print("Running the real Hazard Reader (Part 1, num_zones=2) with an EMPTY existing plan...")
    hr_result = HR.run_hazard_reader(stats, existing_response_actions=[], num_zones=2)
    print(f"  {len(hr_result['priority_zones'])} zone(s), {len(hr_result['uncovered_zones'])} uncovered\n")

    if not hr_result["uncovered_zones"]:
        print("No uncovered zones this run (quota/LLM issue) -- cannot test the Strategist. Aborting.")
        return

    print("Building the real Part 0 context (depth grid, roads, facilities, buildings)...")
    roads = PV.load_roads_geojson()
    ctx = RV.build_context(WATER_LEVEL_M, roads, existing_plan_actions=[])
    print(f"  depth grid {ctx['depth_meta']['width']}x{ctx['depth_meta']['height']}\n")

    print("=" * 70)
    print(f"Running the real Response Strategist (Part 2), max_proposals=2, cause_type={CAUSE_TYPE}...")
    print("=" * 70)
    result = STRAT.run_response_strategist(hr_result["uncovered_zones"], CAUSE_TYPE, ctx, max_proposals=2, max_retries=3)
    proposals = result["proposals"]

    print(f"\n{len(result['trace'])} real trace events:")
    for ev in result["trace"]:
        print(f"  {ev}")

    print(f"\n{len(proposals)} accepted proposal(s):\n")
    for i, p in enumerate(proposals):
        print(f"--- Proposal {i + 1}: {p['action_type']} ---")
        print(f"  location: ({p['location']['lon']:.6f}, {p['location']['lat']:.6f})")
        print(f"  parameters: {p['parameters']}")
        print(f"  ai_reasoning: {p['ai_reasoning']}")
        print(f"  validated_payload: {p['validated_payload']}")
        print(f"  real_coverage: {p['real_coverage']}")

        # Independent re-validation, same discipline as the Prevention
        # Proposer test -- proves the accepted proposal is genuinely
        # re-checkable, not just "the loop said so".
        recheck = RV.VALIDATORS[p["action_type"]](p["location"]["lat"], p["location"]["lon"], ctx)
        print(f"  independent re-validation: {'PASS' if recheck['accepted'] else 'FAIL -- ' + str(recheck.get('reason'))}")
        print()

    print("=" * 70)
    print(f"RESULT: {len(proposals)}/{len(hr_result['uncovered_zones'])} uncovered zones produced an accepted, "
          f"independently-re-validated real proposal.")
    print("=" * 70)


if __name__ == "__main__":
    main()
