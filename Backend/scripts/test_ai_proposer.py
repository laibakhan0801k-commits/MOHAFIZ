"""
Standalone test for ai_proposer.py -- Part 4. Runs the real Hazard
Analyst (Part 3) against a real water level to get real priority zones,
then runs the real Proposer loop against them with a small max_proposals,
printing every accepted proposal's REAL computed impact (not an LLM
guess) and confirming each one passed the exact same validation a human
click would face.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
load_dotenv()

import json
import flood_engine
import ai_hazard_analyst as HA
import ai_proposer as AP

WATER_LEVEL_M = 522
CAUSE_TYPE = "river_overflow"


def load_geojson(name):
    with open(name, encoding="utf-8") as f:
        return json.load(f)


def main():
    print(f"Computing REAL simulation stats for water_level_m={WATER_LEVEL_M}, cause_type={CAUSE_TYPE}...")
    stats = HA.get_current_simulation_stats(WATER_LEVEL_M)
    print(f"  flooded_percent={stats['flooded_percent']}%, roads_cut={stats['roads_cut']}, "
          f"buildings_affected={stats['buildings_affected']}, {len(stats['affected_facilities'])} facilities\n")

    print("Running the real Hazard Analyst (Part 3) for real priority zones...")
    hazard = HA.run_hazard_analyst(stats, num_zones=2)
    print(f"{len(hazard['priority_zones'])} priority zones returned:")
    for i, z in enumerate(hazard["priority_zones"]):
        print(f"  Zone {i + 1}: {z['description'][:90]}... bbox={z['bbox']}")
    print()

    if not hazard["priority_zones"]:
        print("No priority zones -- can't test the Proposer without real zones to feed it. Aborting.")
        return

    print("Loading real waterways/buildings/roads/water_bodies geometry...")
    waterways = load_geojson("waterways.geojson")
    buildings = load_geojson("buildings.geojson")
    water_bodies = load_geojson("water_bodies.geojson")
    import prevention_validation as V
    roads = V.load_roads_geojson()
    print(f"  {len(waterways['features'])} waterways, {len(buildings['features'])} buildings, "
          f"{len(roads['features'])} roads, {len(water_bodies['features'])} water bodies\n")

    elevation, _valid = flood_engine.load_dem()
    dem_bounds = flood_engine.get_dem_bounds()

    print("=" * 70)
    print(f"Running the real Prevention Proposer (Part 4), max_proposals=2, cause_type={CAUSE_TYPE}...")
    print("=" * 70)
    result = AP.run_prevention_proposer(
        hazard["priority_zones"], CAUSE_TYPE, elevation, dem_bounds, WATER_LEVEL_M,
        waterways, buildings, roads, water_bodies,
        existing_plan_actions=[], max_proposals=2, max_retries=3,
    )
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
        print(f"  zone_description: {p['zone_description'][:80]}...")
        impact = p["real_impact"]
        print(f"  REAL impact: flooded% {impact['flooded_percent_before']} -> {impact['flooded_percent_after']}, "
              f"roads_cut {impact['roads_cut_before']} -> {impact['roads_cut_after']} "
              f"(saved {impact['roads_saved']}), area_saved_m2={impact['area_saved_m2']}")
        # Re-verify this exact proposal against the real validator one
        # more time, independently, as a final proof it's genuinely
        # accepted-quality, not just "the loop said so".
        ok, reason = AP._validate_candidate_action(
            p["action_type"],
            {"lon": p["location"]["lon"], "lat": p["location"]["lat"]},
            p["parameters"], waterways, buildings, roads, water_bodies,
        )
        print(f"  independent re-validation: {'PASS' if ok else 'FAIL -- ' + str(reason)}")
        print()

    print("=" * 70)
    print(f"RESULT: {len(proposals)}/{len(hazard['priority_zones'])} zones produced an accepted, "
          f"independently-re-validated real proposal.")
    print("=" * 70)


if __name__ == "__main__":
    main()
