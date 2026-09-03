"""
Standalone test for ai_response_evaluator.py -- Part 3. No LLM calls at
all (this agent is pure real coverage math) -- tests the before/after
comparison against constructed-but-realistic action lists at real
coordinates, confirming: (1) an empty plan shows 0% coverage everywhere,
(2) adding a real evacuation zone genuinely moves the evacuation
percentage, (3) before/after never drifts onto different at-risk
totals since both come from the same function.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

import prevention_validation as PV
import response_validation as RV
import ai_response_evaluator as EV

WATER_LEVEL_M = 553


def main():
    print(f"Building real context at water_level_m={WATER_LEVEL_M}...")
    roads = PV.load_roads_geojson()
    ctx = RV.build_context(WATER_LEVEL_M, roads, existing_plan_actions=[])

    print("Computing real at-risk buildings from the live depth grid...")
    at_risk = EV.river_overflow_at_risk_buildings(ctx["depth_grid"], ctx["depth_meta"], ctx["buildings_geojson"])
    print(f"  {len(at_risk)} real at-risk buildings\n")

    print("=" * 70)
    print("TEST 1: empty plan -- baseline coverage must be all zero")
    print("=" * 70)
    baseline = EV.compute_river_overflow_response_coverage(WATER_LEVEL_M, ctx, [])
    print(baseline)
    assert baseline["evacuation"]["covered"] == 0
    assert baseline["warning"]["covered"] == 0
    assert baseline["roads"]["closed"] == 0
    assert baseline["total_buildings"] == len(at_risk)

    print("\n" + "=" * 70)
    print("TEST 2: one evacuation zone placed at a REAL at-risk building's")
    print("        location, radius 300m -- coverage must genuinely rise")
    print("=" * 70)
    anchor = at_risk[len(at_risk) // 2]  # a real at-risk point, not an arbitrary one
    plan = [{"type": "evacuationZone", "lat": anchor["lat"], "lon": anchor["lon"], "params": {"radius_m": 300}}]
    with_zone = EV.compute_river_overflow_response_coverage(WATER_LEVEL_M, ctx, plan)
    print(with_zone)
    assert with_zone["evacuation"]["covered"] > 0, "Expected real coverage increase from a real nearby zone"
    assert with_zone["total_buildings"] == baseline["total_buildings"], "at-risk total must not drift between calls"

    print("\n" + "=" * 70)
    print("TEST 3: run_response_evaluator before/after, adding a warning")
    print("        point (camelCase params, like a real frontend marker)")
    print("        on top of the evacuation-zone plan")
    print("=" * 70)
    proposed = [{"type": "warningPoint", "lat": anchor["lat"], "lon": anchor["lon"], "parameters": {"coverage_radius_m": 400}}]
    result = EV.run_response_evaluator(WATER_LEVEL_M, ctx, plan, proposed)
    print("BEFORE:", result["before"])
    print("AFTER: ", result["after"])
    assert result["before"]["evacuation"]["covered"] == with_zone["evacuation"]["covered"]
    assert result["after"]["warning"]["covered"] > 0, "Expected the new warning point to genuinely cover buildings"
    assert result["after"]["evacuation"]["covered"] == result["before"]["evacuation"]["covered"], \
        "Adding a warning point must not change evacuation coverage -- different category"

    print("\n" + "=" * 70)
    print("TEST 4: camelCase (frontend marker shape) vs snake_case")
    print("        (Strategist proposal shape) radius keys both read")
    print("        correctly -- same coverage result either way")
    print("=" * 70)
    camel = EV.compute_river_overflow_response_coverage(WATER_LEVEL_M, ctx, [
        {"type": "evacuationZone", "lat": anchor["lat"], "lon": anchor["lon"], "params": {"radiusM": 300}},
    ])
    snake = EV.compute_river_overflow_response_coverage(WATER_LEVEL_M, ctx, [
        {"type": "evacuationZone", "lat": anchor["lat"], "lon": anchor["lon"], "parameters": {"radius_m": 300}},
    ])
    print("camelCase result:", camel["evacuation"])
    print("snake_case result:", snake["evacuation"])
    assert camel["evacuation"]["covered"] == snake["evacuation"]["covered"] == with_zone["evacuation"]["covered"]

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED. Every number above is real coverage math")
    print("against the live depth grid and real building centroids.")
    print("=" * 70)


if __name__ == "__main__":
    main()
