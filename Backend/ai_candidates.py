"""
AI PREVENTION PROPOSER -- real candidate point enumeration.

The LLM never invents a lat/lon. It only ever picks from a real, finite,
pre-generated list of candidate points by id -- this file's job is
generating that list. Every candidate here sits on REAL geometry (a
sampled point along a real waterway feature, a real building's interior
point within the real encroachment distance band) -- never an
arbitrary coordinate the model could hallucinate its way around.
"""
import math

from shapely.geometry import Point, shape

import prevention_constants as C
import prevention_validation as V

# Action types anchored to the waterway network -- candidates are real
# points sampled every `spacing_m` along each real waterway feature.
WATERWAY_ANCHORED_ACTIONS = (
    "embankment", "desilt", "clearDrains", "widenChannel",
    "warningGauge", "retentionPond", "greenBuffer",
)

# Actions that must sit BESIDE the channel, not in it. Their real
# placement rule (prevention_constants.ACTION_VALIDATION_CONFIG) has a
# minWaterwayDistance above zero -- a retention pond has to be 10-100m
# from the nullah, a green buffer 5-40m. Candidates sampled ON the
# waterway line are 0m from it, so EVERY one of them failed validation
# and these two action types could never be proposed at all. For
# rainfall that silently removed both of the catchment's top-ranked
# measures, leaving only capacity actions whose basin-wide effect is
# too small to see. Embankment is here for the same reason: it must sit
# 5-50m from the channel, and a real river_overflow run proposed not a
# single one because every candidate offered to it was in the water.
# Candidates for these are offset perpendicular to the local channel
# direction instead, onto both banks -- which is where an embankment,
# a pond and a buffer strip are actually built.
BANK_OFFSET_ACTIONS = ("retentionPond", "greenBuffer", "embankment")

# Fractions of the allowed [min, max] band to try, inner-to-outer. A
# pond wants to be close enough to intercept the channel's overspill
# but far enough to have room, so the band's middle is tried first.
_BANK_OFFSET_FRACTIONS = (0.45, 0.75, 0.2, 0.95)


def _local_bearing_rad(coords, target_m):
    """Direction of the channel at target_m along it, from the two
    sampled points straddling that position. Real geometry only."""
    delta = 8.0
    total = V.line_length_m(coords)
    a_m = max(0.0, min(total, target_m - delta))
    b_m = max(0.0, min(total, target_m + delta))
    if b_m - a_m < 1e-6:
        return None
    a = V.interpolate_line_m(coords, a_m)
    b = V.interpolate_line_m(coords, b_m)
    if a is None or b is None:
        return None
    mid_lat_rad = math.radians((a[1] + b[1]) / 2.0)
    dx = (b[0] - a[0]) * math.cos(mid_lat_rad)
    dy = (b[1] - a[1])
    if abs(dx) < 1e-12 and abs(dy) < 1e-12:
        return None
    return math.atan2(dy, dx)


def _offset_point(lon, lat, bearing_rad, distance_m, side):
    """Move distance_m perpendicular to bearing_rad, onto one bank."""
    perp = bearing_rad + (math.pi / 2.0) * side
    d_lat = (distance_m * math.sin(perp)) / 111320.0
    cos_lat = math.cos(math.radians(lat)) or 1e-9
    d_lon = (distance_m * math.cos(perp)) / (111320.0 * cos_lat)
    return lon + d_lon, lat + d_lat


def _bank_offsets_for(action_type):
    """Real offset distances to try, taken from the action's OWN
    validation config so a candidate is never generated outside the
    band the real placement rule enforces."""
    config = C.ACTION_VALIDATION_CONFIG.get(action_type, {})
    lo = float(config.get("minWaterwayDistance", 0) or 0)
    hi = float(config.get("maxWaterwayDistance", 0) or 0)
    if hi <= lo:
        return []
    # Stay a couple of metres inside both ends of the band -- the offset
    # is computed against the local channel direction, so a candidate
    # placed exactly at the limit can measure just outside it against
    # the full network geometry.
    lo_safe, hi_safe = lo + 2.0, hi - 2.0
    if hi_safe <= lo_safe:
        return []
    return [round(lo_safe + f * (hi_safe - lo_safe), 1) for f in _BANK_OFFSET_FRACTIONS]


def _point_in_bbox(lon, lat, bbox):
    w, s, e, n = bbox
    return w <= lon <= e and s <= lat <= n


def generate_candidate_points(action_type, priority_bbox, waterways_geojson,
                               buildings_geojson, spacing_m=30):
    """
    Enumerates REAL candidate points within a priority zone (bbox, from
    the Hazard Analyst) for the Proposer to choose from, by id.

    - Waterway-anchored actions (see WATERWAY_ANCHORED_ACTIONS): every
      `spacing_m` along each real waterway LineString feature that
      falls inside the bbox.
    - removeEncroachment: real building interior points inside the
      bbox, within the real ENCROACHMENT distance band
      (ACTION_VALIDATION_CONFIG['removeEncroachment']['maxWaterwayDistance']),
      excluding essential-amenity buildings -- same exclusion list the
      real click-validation config already uses.

    Returns a list of {id, lon, lat, descriptor, ...}. Never returns a
    lat/lon that isn't a real point taken from real input geometry.
    """
    candidates = []
    cid = 0

    # Points on the waterway that fell OUTSIDE this zone's bbox, kept so
    # a zone that happens to sit away from the nullah can still be given
    # the nearest real channel points instead of nothing at all.
    _outside = []

    bank_offsets = _bank_offsets_for(action_type) if action_type in BANK_OFFSET_ACTIONS else []

    if action_type in WATERWAY_ANCHORED_ACTIONS:
        for feature in waterways_geojson.get("features", []):
            geom = feature.get("geometry")
            if not geom or geom["type"] != "LineString":
                continue
            coords = geom["coordinates"]
            length_m = V.line_length_m(coords)
            if length_m <= 0:
                continue
            num_points = max(1, round(length_m / spacing_m))
            name = (feature.get("properties") or {}).get("name") or "Unnamed waterway"
            for i in range(num_points + 1):
                target_m = (i / num_points) * length_m
                lon, lat = V.interpolate_line_m(coords, target_m)
                if not _point_in_bbox(lon, lat, priority_bbox):
                    # Keep it as a fallback rather than discarding it --
                    # see the nearest-waterway fallback below.
                    _outside.append((lon, lat, name, target_m, coords))
                    continue

                if bank_offsets:
                    # Beside the channel, not in it -- see
                    # BANK_OFFSET_ACTIONS. Both banks, several real
                    # distances inside the action's own allowed band.
                    bearing = _local_bearing_rad(coords, target_m)
                    if bearing is None:
                        continue
                    for off_m in bank_offsets:
                        for side in (1, -1):
                            b_lon, b_lat = _offset_point(lon, lat, bearing, off_m, side)
                            if not _point_in_bbox(b_lon, b_lat, priority_bbox):
                                continue
                            candidates.append({
                                "id": cid,
                                "lon": b_lon,
                                "lat": b_lat,
                                "waterway_name": name,
                                "descriptor": (
                                    f"{off_m}m from {name} "
                                    f"({'left' if side > 0 else 'right'} bank), "
                                    f"{round(target_m)}m along this segment"
                                ),
                            })
                            cid += 1
                    continue

                candidates.append({
                    "id": cid,
                    "lon": lon,
                    "lat": lat,
                    "waterway_name": name,
                    "descriptor": f"On {name}, {round(target_m)}m along this segment",
                })
                cid += 1

    elif action_type == "removeEncroachment":
        config = C.ACTION_VALIDATION_CONFIG["removeEncroachment"]
        excluded_amenities = set(config.get("excludeAmenities") or [])
        max_dist_m = config.get("maxWaterwayDistance")

        for feature in buildings_geojson.get("features", []):
            props = feature.get("properties") or {}
            if props.get("amenity") in excluded_amenities:
                continue
            geom = feature.get("geometry")
            if not geom:
                continue
            gtype = geom["type"]
            if gtype in ("Polygon", "MultiPolygon"):
                # representative_point(), not centroid -- centroid can
                # land OUTSIDE a concave building footprint (see the
                # real bug this caught in Part 1's standalone test).
                center = shape(geom).representative_point()
            elif gtype == "Point":
                center = Point(geom["coordinates"])
            else:
                continue

            if not _point_in_bbox(center.x, center.y, priority_bbox):
                continue

            dist_m = V.nearest_line_distance_m(center, waterways_geojson)
            if dist_m is None or dist_m > max_dist_m:
                continue

            candidates.append({
                "id": cid,
                "lon": center.x,
                "lat": center.y,
                "descriptor": f"Building ({props.get('building', 'unspecified')}), {round(dist_m)}m from nullah",
            })
            cid += 1

    # A hazard zone can legitimately sit away from the nullah -- at one
    # real water level the model's zones produced ZERO waterway
    # candidates for every prevention action, so nothing could be
    # proposed at all. Fall back to the nearest real channel points to
    # the zone's centre. Still real points on the real waterway; only
    # the selection rule changes, from "inside the box" to "closest to
    # the area flagged", which is what a planner would actually do.
    if not candidates and _outside:
        clat = (priority_bbox[1] + priority_bbox[3]) / 2.0
        clon = (priority_bbox[0] + priority_bbox[2]) / 2.0
        _outside.sort(key=lambda t: V.distance_m(clon, clat, t[0], t[1]))
        for lon, lat, name, target_m, coords in _outside[:40]:
            if bank_offsets:
                # Same bank-offset treatment as the in-bbox path. Without
                # it this fallback handed retentionPond/greenBuffer forty
                # points sitting IN the channel, every one of which their
                # own placement rule rejects -- so a zone that fell back
                # here still ended up with no valid pond or buffer.
                bearing = _local_bearing_rad(coords, target_m)
                if bearing is None:
                    continue
                for off_m in bank_offsets:
                    for side in (1, -1):
                        b_lon, b_lat = _offset_point(lon, lat, bearing, off_m, side)
                        candidates.append({
                            "id": len(candidates),
                            "lon": b_lon,
                            "lat": b_lat,
                            "waterway_name": name,
                            "descriptor": (
                                f"{off_m}m from {name} "
                                f"({'left' if side > 0 else 'right'} bank), "
                                f"{round(target_m)}m along it (nearest reach to this zone)"
                            ),
                        })
                continue
            candidates.append({
                "id": len(candidates),
                "lon": lon,
                "lat": lat,
                "waterway_name": name,
                "descriptor": f"On {name}, {round(target_m)}m along this segment (nearest reach to this zone)",
            })

    return candidates


def filter_out_overlapping(candidates, existing_plan_actions, min_gap_m=None):
    """Drops candidates that sit within min_gap_m of an EXISTING placed
    action of any type, so the AI can't propose a duplicate of something
    the user already placed. `existing_plan_actions` items need
    lon/lat (or lng/lat) keys -- the same shape PreventionAction carries
    in main.py. Defaults min_gap_m to EMBANKMENT_SAMPLE_INTERVAL_M * 6 =
    30m, matching PlanWorkspace.js's own SAME_TYPE_OVERLAP-style spacing
    used elsewhere in this codebase for "too close to an existing
    action" checks."""
    if min_gap_m is None:
        min_gap_m = 30
    if not existing_plan_actions:
        return candidates

    existing_points = []
    for a in existing_plan_actions:
        lon = a.get("lon", a.get("lng"))
        lat = a.get("lat")
        if lon is not None and lat is not None:
            existing_points.append((lon, lat))

    if not existing_points:
        return candidates

    kept = []
    for c in candidates:
        too_close = any(
            V.distance_m(c["lon"], c["lat"], elon, elat) < min_gap_m
            for elon, elat in existing_points
        )
        if not too_close:
            kept.append(c)
    return kept
