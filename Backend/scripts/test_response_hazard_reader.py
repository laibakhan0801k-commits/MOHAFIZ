"""
Standalone test for ai_response_hazard_reader.py -- Part 1. One real
Hazard Analyst call (kept small -- num_zones=2 -- to go easy on the
Groq daily quota, already exhausted twice this session) to get real
zones, then thorough testing of the NEW deterministic coverage filter
against constructed existing-plan actions at known real distances from
those zones' actual centers.
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

WATER_LEVEL_M = 522


def main():
    print(f"Computing REAL simulation stats for water_level_m={WATER_LEVEL_M}...")
    stats = HA.get_current_simulation_stats(WATER_LEVEL_M)
    print(f"  flooded_percent={stats['flooded_percent']}%, roads_cut={stats['roads_cut']}, "
          f"buildings_affected={stats['buildings_affected']}\n")

    print("Running ONE real Hazard Analyst call (num_zones=2) for real zones...")
    hazard = HA.run_hazard_analyst(stats, num_zones=2)
    zones = hazard["priority_zones"]
    print(f"{len(zones)} real zone(s) returned:")
    for i, z in enumerate(zones):
        w, s, e, n = z["bbox"]
        print(f"  Zone {i}: {z['description'][:80]}...  bbox=({w:.5f},{s:.5f},{e:.5f},{n:.5f})")
    print()

    if not zones:
        print("No real zones returned this run (quota/LLM issue) -- cannot test coverage filtering. Aborting.")
        return

    z0 = zones[0]
    w, s, e, n = z0["bbox"]
    zlat, zlon = (s + n) / 2, (w + e) / 2
    print(f"Zone 0's real center: ({zlat:.6f}, {zlon:.6f})\n")

    print("=" * 70)
    print("TEST 1: no existing plan -- every zone must be 'uncovered'")
    print("=" * 70)
    r1 = HR.annotate_zone_coverage(zones, [])
    for z in r1:
        print(f"  covered={z['covered']}, covering_actions={z['covering_actions']}")
    assert all(not z["covered"] for z in r1), "Expected nothing covered with an empty plan"

    print("\n" + "=" * 70)
    print("TEST 2: an evacuationZone marker placed EXACTLY at zone 0's")
    print("        center, radius 300m -- zone 0 must become covered")
    print("=" * 70)
    plan = [{"type": "evacuationZone", "lat": zlat, "lon": zlon, "radius_m": 300}]
    r2 = HR.annotate_zone_coverage(zones, plan)
    print(f"  zone 0: covered={r2[0]['covered']}, covering_actions={r2[0]['covering_actions']}")
    assert r2[0]["covered"] is True
    assert "evacuationZone" in r2[0]["covering_actions"]

    print("\n" + "=" * 70)
    print("TEST 3: a warningPoint 10km away -- zone 0 must stay uncovered")
    print("        (real distance, not just 'a marker exists somewhere')")
    print("=" * 70)
    far_plan = [{"type": "warningPoint", "lat": zlat + 0.09, "lon": zlon, "coverage_radius_m": 400}]
    from prevention_validation import distance_m
    d = distance_m(zlon, zlat, far_plan[0]["lon"], far_plan[0]["lat"])
    print(f"  real distance from zone 0 center to this warning point: {d:.0f}m")
    r3 = HR.annotate_zone_coverage(zones, far_plan)
    print(f"  zone 0: covered={r3[0]['covered']}, covering_actions={r3[0]['covering_actions']}")
    assert d > 400, "Test setup bug -- point should be far outside the 400m coverage radius"
    assert r3[0]["covered"] is False

    print("\n" + "=" * 70)
    print("TEST 4: run_hazard_reader end-to-end -- structural check only.")
    print("        NOT re-asserting 'zone 0 becomes covered' here: this")
    print("        makes its OWN independent real Hazard Analyst call, so")
    print("        the LLM is free to return different zone(s) than the")
    print("        earlier call did -- already proven deterministic and")
    print("        correct by tests 1-3 above against known real zones.")
    print("=" * 70)
    result = HR.run_hazard_reader(stats, existing_response_actions=plan, num_zones=2)
    print(f"  priority_zones: {len(result['priority_zones'])}, uncovered_zones: {len(result['uncovered_zones'])}")
    for z in result["priority_zones"]:
        print(f"    covered={z['covered']}, covering_actions={z['covering_actions']}, desc={z['description'][:60]}...")
    assert len(result["uncovered_zones"]) <= len(result["priority_zones"])
    assert all(z["covered"] is False for z in result["uncovered_zones"]), "uncovered_zones must never contain a covered zone"

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED. Zone identification reused the proven real")
    print("Hazard Analyst; coverage filtering is real geometry against the")
    print("actual zone centers and constructed plan points above.")
    print("=" * 70)


if __name__ == "__main__":
    main()
