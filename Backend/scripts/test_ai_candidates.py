"""
Standalone test for ai_candidates.py -- Part 2 of the AI Prevention
Proposer build. Confirms generate_candidate_points() returns real, sane
points for a real sample bbox (a padded box around one real waterway
feature's own extent), for both the waterway-anchored and
removeEncroachment code paths, and that filter_out_overlapping() drops
candidates near a real existing action.
"""
import json
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

import ai_candidates as AC
import prevention_validation as V


def load_geojson(name):
    with open(name, encoding="utf-8") as f:
        return json.load(f)


def main():
    waterways = load_geojson("waterways.geojson")
    buildings = load_geojson("buildings.geojson")

    # Real bbox: pad the extent of ONE real waterway feature (not a
    # made-up box) so the test proves candidates land on real geometry
    # inside a realistic Hazard-Analyst-shaped priority zone.
    feature = next(f for f in waterways["features"] if f["geometry"]["type"] == "LineString" and len(f["geometry"]["coordinates"]) >= 5)
    coords = feature["geometry"]["coordinates"]
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    pad = 0.001
    bbox = [min(lons) - pad, min(lats) - pad, max(lons) + pad, max(lats) + pad]
    name = (feature.get("properties") or {}).get("name") or "Unnamed"
    print(f"Priority bbox around real waterway '{name}': {bbox}\n")

    print("=" * 70)
    print("TEST 1 -- waterway-anchored candidates (embankment)")
    print("=" * 70)
    candidates = AC.generate_candidate_points("embankment", bbox, waterways, buildings, spacing_m=30)
    print(f"{len(candidates)} candidates generated")
    for c in candidates[:5]:
        print(f"  id={c['id']} ({c['lon']:.6f}, {c['lat']:.6f}) -- {c['descriptor']}")
    # Sanity: every candidate must be a real point ON the waterway network
    # (within a tiny tolerance of some real waterway feature).
    max_dist_from_any_waterway = 0
    for c in candidates:
        from shapely.geometry import Point
        d = V.nearest_line_distance_m(Point(c["lon"], c["lat"]), waterways)
        max_dist_from_any_waterway = max(max_dist_from_any_waterway, d)
    print(f"Max distance of any candidate from the real waterway network: {max_dist_from_any_waterway:.2f}m "
          f"({'PASS -- effectively 0' if max_dist_from_any_waterway < 0.5 else 'FAIL -- candidates are NOT on real geometry'})\n")

    print("=" * 70)
    print("TEST 2 -- waterway-anchored candidates, other action types share the same path")
    print("=" * 70)
    for action_type in ("desilt", "clearDrains", "widenChannel", "warningGauge", "retentionPond", "greenBuffer"):
        c = AC.generate_candidate_points(action_type, bbox, waterways, buildings, spacing_m=30)
        print(f"  {action_type}: {len(c)} candidates")
    print()

    print("=" * 70)
    print("TEST 3 -- removeEncroachment candidates (real buildings, excluding essential amenities)")
    print("=" * 70)
    # Wider bbox needed -- buildings near this particular waterway
    # feature may be sparse in a 0.001-deg pad; widen to find real ones.
    wide_bbox = [bbox[0] - 0.004, bbox[1] - 0.004, bbox[2] + 0.004, bbox[3] + 0.004]
    encroachment_candidates = AC.generate_candidate_points("removeEncroachment", wide_bbox, waterways, buildings)
    print(f"{len(encroachment_candidates)} candidates in widened bbox {wide_bbox}")
    for c in encroachment_candidates[:5]:
        print(f"  id={c['id']} ({c['lon']:.6f}, {c['lat']:.6f}) -- {c['descriptor']}")
    excluded = {"school", "college", "university", "hospital", "clinic", "doctors", "place_of_worship", "government"}
    violation = False
    for c in encroachment_candidates:
        # Re-derive which building this candidate came from isn't tracked
        # directly, so instead just confirm none of the real EXCLUDED
        # amenity buildings' representative points appear among candidates.
        pass
    for f in buildings["features"]:
        props = f.get("properties") or {}
        if props.get("amenity") in excluded:
            from shapely.geometry import shape as shapely_shape
            pt = shapely_shape(f["geometry"]).representative_point() if f["geometry"]["type"] in ("Polygon", "MultiPolygon") else None
            if pt and any(abs(c["lon"] - pt.x) < 1e-9 and abs(c["lat"] - pt.y) < 1e-9 for c in encroachment_candidates):
                violation = True
                print(f"  VIOLATION: excluded amenity '{props.get('amenity')}' building appears as a candidate!")
    print(f"Exclusion check: {'FAIL' if violation else 'PASS -- no excluded-amenity building appears as a candidate'}\n")

    print("=" * 70)
    print("TEST 4 -- filter_out_overlapping drops candidates near a real existing action")
    print("=" * 70)
    if candidates:
        existing = [{"lon": candidates[0]["lon"], "lat": candidates[0]["lat"], "type": "embankment"}]
        before_count = len(candidates)
        filtered = AC.filter_out_overlapping(candidates, existing, min_gap_m=30)
        print(f"Existing action at candidate[0]'s real location ({existing[0]['lon']:.6f}, {existing[0]['lat']:.6f})")
        print(f"Candidates before filtering: {before_count}, after: {len(filtered)} "
              f"({'PASS -- at least the exact-overlap one was dropped' if len(filtered) < before_count else 'FAIL -- nothing was filtered'})")
    else:
        print("No candidates to test overlap filtering against.")


if __name__ == "__main__":
    main()
