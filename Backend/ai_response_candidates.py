"""
Response-side multi-agent AI comparison -- real candidate point
enumeration for Agent 2 (Strategist), mirroring ai_candidates.py's rule
for the Prevention Proposer: the LLM never invents a lat/lon, it only
ever picks from a real, finite, pre-generated list of candidate points
by id.

Each response action type is anchored to whichever real feature a human
placing it would actually use:
  - warningPoint / reliefMedicalPost -- real mapped facilities (mosques,
    schools, community centres...) within the zone, since both
    resolvers snap onto one anyway if it's close enough and safe.
  - closeRoad / boatLaunch -- real road segments within the zone,
    sampled every spacing_m, filtered to ones genuinely near/in the
    flood (skipping dry roads a human would never click for either).
  - evacuationZone -- has no snap target; the real anchor is the flood
    itself, so candidates are a coarse grid filtered to wet cells.
"""
import math

from response_validation import (
    WARNING_SNAP_AMENITIES, SHELTER_AMENITIES, RULES,
    depth_at_point, nearest_road, _feature_centroid,
)
from prevention_validation import distance_m


def _point_in_bbox(lon, lat, bbox):
    w, s, e, n = bbox
    return w <= lon <= e and s <= lat <= n


def _facility_candidates(amenity_types, zone_bbox, facilities_geojson):
    candidates = []
    cid = 0
    for feature in (facilities_geojson or {}).get("features", []):
        props = feature.get("properties") or {}
        if props.get("amenity") not in amenity_types:
            continue
        c = _feature_centroid(feature)
        if c is None or not _point_in_bbox(c[0], c[1], zone_bbox):
            continue
        candidates.append({
            "id": cid, "lon": c[0], "lat": c[1],
            "descriptor": f"{props.get('name') or 'Unnamed ' + str(props.get('amenity'))} ({props.get('amenity')})",
        })
        cid += 1
    return candidates


def _road_candidates(zone_bbox, roads_geojson, ctx, spacing_m, require_wet, wet_search_m):
    """Real points sampled every spacing_m along roads inside the zone.
    require_wet keeps only points genuinely near real floodwater (using
    the same depth grid the validators read), at wet_search_m distance
    -- e.g. ON the road for closeRoad, or within boat-launch adjacency
    for boatLaunch."""
    from prevention_validation import line_length_m, interpolate_line_m
    from response_validation import scan_depth_near

    candidates = []
    cid = 0
    for feature in roads_geojson.get("features", []):
        geom = feature.get("geometry")
        if not geom or geom["type"] != "LineString":
            continue
        coords = geom["coordinates"]
        length_m = line_length_m(coords)
        if length_m <= 0:
            continue
        num_points = max(1, round(length_m / spacing_m))
        props = feature.get("properties") or {}
        name = props.get("name") or "Unnamed road"
        for i in range(num_points + 1):
            target_m = (i / num_points) * length_m
            lon, lat = interpolate_line_m(coords, target_m)
            if not _point_in_bbox(lon, lat, zone_bbox):
                continue
            if require_wet:
                depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
                is_wet = depth is not None and depth > 0
                if not is_wet and wet_search_m > 0:
                    scan = scan_depth_near(lat, lon, wet_search_m, ctx["depth_grid"], ctx["depth_meta"])
                    is_wet = scan["wet_cells"] > 0
                if not is_wet:
                    continue
            candidates.append({
                "id": cid, "lon": lon, "lat": lat,
                "descriptor": f"On {name}, {round(target_m)}m along this segment",
            })
            cid += 1
    return candidates


def _wet_grid_candidates(zone_bbox, ctx, spacing_m=100):
    w, s, e, n = zone_bbox
    lat_mid = (s + n) / 2
    m_per_deg_lon = 111320 * math.cos(math.radians(lat_mid))
    step_lat = spacing_m / 111320
    step_lon = spacing_m / max(m_per_deg_lon, 1e-6)

    candidates = []
    cid = 0
    lat = s + step_lat / 2
    while lat <= n:
        lon = w + step_lon / 2
        while lon <= e:
            depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
            if depth is not None and depth > 0:
                candidates.append({
                    "id": cid, "lon": lon, "lat": lat,
                    "descriptor": f"Flooded point, {depth:.1f}m deep",
                })
                cid += 1
            lon += step_lon
        lat += step_lat
    return candidates


def generate_candidates(action_type, zone_bbox, ctx):
    """Returns a list of {id, lon, lat, descriptor} real candidate
    points for one action type within one hazard zone's bbox."""
    if action_type == "warningPoint":
        return _facility_candidates(WARNING_SNAP_AMENITIES, zone_bbox, ctx["facilities_geojson"])
    if action_type == "reliefMedicalPost":
        return _dry_facility_candidates(SHELTER_AMENITIES, zone_bbox, ctx)
    if action_type == "closeRoad":
        return _road_candidates(zone_bbox, ctx["roads_geojson"], ctx, spacing_m=30, require_wet=True, wet_search_m=0)
    if action_type == "boatLaunch":
        return _road_candidates(zone_bbox, ctx["roads_geojson"], ctx, spacing_m=30, require_wet=True,
                                 wet_search_m=RULES["BOAT_WATER_ADJACENCY_M"])
    if action_type == "evacuationZone":
        return _wet_grid_candidates(zone_bbox, ctx, spacing_m=100)

    # ---- RAINFALL ----------------------------------------------------
    # Rainfall has no modelled flood extent, so "where could this go"
    # comes from the terrain-derived drainage-risk zones and the mapped
    # underpass/road-sag low points instead of wet grid cells. Same
    # {id, lon, lat, descriptor} shape either way, so the Strategist
    # never needs to know which scenario produced the list.
    if action_type in ("rainEvacZone", "rainWaterRescue"):
        return _risk_zone_candidates(zone_bbox)
    if action_type == "rainRoadClosure":
        return _low_point_candidates(zone_bbox)
    # ---- DRAINAGE FAILURE --------------------------------------------
    # Culvert clearance and overflow flags are road-network features;
    # pumps go to chronic low points; bypass/vector-control go where the
    # live depth grid is actually wet.
    if action_type == "drainBlockageClearance":
        return _culvert_candidates(zone_bbox, ctx)
    if action_type == "drainSewerOverflow":
        return _junction_candidates(zone_bbox, ctx)
    if action_type == "drainPumpDeployment":
        return _low_point_candidates(zone_bbox)
    if action_type in ("drainBypass", "drainVectorControl"):
        return _wet_grid_candidates(zone_bbox, ctx, spacing_m=100)

    # ---- DAM RELEASE -------------------------------------------------
    # Organised by wave-arrival TIME rather than depth. Warning points
    # snap to real facilities; evacuation/tracking sit in the surge
    # extent; crossings are on the channel; rally points must be DRY
    # high ground, so they are the one action whose candidates come from
    # the non-flooded grid.
    if action_type == "damWarningPoint":
        return _rainfall_facility_candidates(WARNING_SNAP_AMENITIES, zone_bbox, ctx["facilities_geojson"])
    if action_type in ("damEvacZone", "damReleaseTracking"):
        return _wet_grid_candidates(zone_bbox, ctx, spacing_m=100)
    if action_type == "damCrossingClosure":
        return _waterway_candidates(zone_bbox, ctx)
    if action_type == "damRallyPoint":
        return _dry_grid_candidates(zone_bbox, ctx, spacing_m=100)

    if action_type == "rainWarning":
        return _rainfall_facility_candidates(WARNING_SNAP_AMENITIES, zone_bbox, ctx["facilities_geojson"])
    if action_type in ("rainMedicalPost", "rainReliefCamp"):
        return _dry_facility_candidates(SHELTER_AMENITIES, zone_bbox, ctx)
    return []


def _rainfall_facility_candidates(amenity_types, zone_bbox, facilities_geojson):
    """Same facility list as the river-overflow side, but with the same
    nearest-features fallback the other rainfall generators use -- a
    small hazard bbox often contains no mapped school/mosque at all."""
    def coord_of(f):
        props = f.get("properties") or {}
        if props.get("amenity") not in amenity_types:
            return None
        c = _feature_centroid(f)
        return None if c is None else (c[0], c[1])

    def describe(f):
        p = f.get("properties") or {}
        return f"{p.get('name') or 'Unnamed ' + str(p.get('amenity'))} ({p.get('amenity')})"

    return _collect_with_fallback(zone_bbox, (facilities_geojson or {}).get("features", []), describe, coord_of)


# Rainfall's real features are SPARSE -- 252 drainage-risk zones and 402
# low points spread across the whole ~49 km2 modelled area. A hazard
# zone's bbox frequently contains none of them at all, which produced
# "no_candidates" for every rainfall action and an empty plan. When that
# happens, fall back to the nearest real features to the zone's centre,
# out to this radius. Still real mapped locations -- only the selection
# rule changes, from "strictly inside the box" to "closest to the area
# the analyst flagged", which is what a planner would actually do.
NEAREST_FALLBACK_MAX_M = 2500
NEAREST_FALLBACK_COUNT = 25


def _bbox_center(zone_bbox):
    w, s, e, n = zone_bbox
    return (s + n) / 2.0, (w + e) / 2.0


def _collect_with_fallback(zone_bbox, features, describe, coord_of):
    """Features inside the bbox; if none, the nearest ones to its centre."""
    import response_validation as RV
    w, s, e, n = zone_bbox
    inside, scored = [], []
    clat, clon = _bbox_center(zone_bbox)
    for f in features:
        c = coord_of(f)
        if c is None:
            continue
        lon, lat = c
        if w <= lon <= e and s <= lat <= n:
            inside.append((lon, lat, f))
        else:
            scored.append((RV.distance_m(clon, clat, lon, lat), lon, lat, f))

    chosen = inside
    if not chosen:
        scored.sort(key=lambda t: t[0])
        chosen = [(lon, lat, f) for d, lon, lat, f in scored[:NEAREST_FALLBACK_COUNT]
                  if d <= NEAREST_FALLBACK_MAX_M]

    return [
        {"id": i, "lon": lon, "lat": lat, "descriptor": describe(f)}
        for i, (lon, lat, f) in enumerate(chosen)
    ]


def _risk_zone_candidates(zone_bbox):
    """One candidate per real drainage-risk zone -- rainfall pools in
    these specific mapped pockets, so they are the only places an
    evacuation zone or rescue staging point can legitimately go."""
    import response_validation_rainfall as RVR

    def coord_of(f):
        p = f.get("properties") or {}
        lon, lat = p.get("centroid_lon"), p.get("centroid_lat")
        return None if lon is None or lat is None else (lon, lat)

    def describe(f):
        p = f.get("properties") or {}
        return f"{p.get('risk_class', 'unknown')} drainage-risk zone, pools up to {p.get('max_sink_m', '?')}m"

    return _collect_with_fallback(zone_bbox, RVR.load_drainage_risk().get("features", []), describe, coord_of)


def _low_point_candidates(zone_bbox):
    """One candidate per real mapped underpass / road sag -- the only
    points a rainfall road closure is valid at."""
    import response_validation_rainfall as RVR

    def coord_of(f):
        c = f["geometry"]["coordinates"]
        return (c[0], c[1])

    def describe(f):
        p = f.get("properties") or {}
        kind = "underpass" if p.get("kind") == "underpass" else "road sag"
        return f"{p.get('name') or 'Unnamed road'} -- {kind}, drop {p.get('drop_m', '?')}m"

    return _collect_with_fallback(zone_bbox, RVR.load_road_low_points().get("features", []), describe, coord_of)


def filter_out_overlapping(candidates, existing_response_actions, min_gap_m=30):
    """Drops candidates within min_gap_m of an action already in the
    user's plan, so the AI can't propose a near-duplicate of something
    placed by hand."""
    if not existing_response_actions:
        return candidates
    existing_points = [(a["lon"], a["lat"]) for a in existing_response_actions if a.get("lon") is not None and a.get("lat") is not None]
    if not existing_points:
        return candidates
    return [
        c for c in candidates
        if not any(distance_m(c["lon"], c["lat"], elon, elat) < min_gap_m for elon, elat in existing_points)
    ]


def _junction_candidates(zone_bbox, ctx):
    """Real road-graph junctions (the manhole stand-in for sewer
    overflow points), with the same nearest-features fallback the
    rainfall generators use."""
    import response_validation_drainage as RVD

    def coord_of(j):
        if j["degree"] < RVD.RULES["JUNCTION_MIN_DEGREE"]:
            return None
        return (j["lon"], j["lat"])

    def describe(j):
        return f"road junction, {j['degree']} connecting segments"

    return _collect_with_fallback(zone_bbox, RVD.road_junctions(ctx), describe, coord_of)


def _culvert_candidates(zone_bbox, ctx):
    """Real culvert crossings: points on a HIGH-CAPACITY road that are
    both within the validator's culvert distance of the mapped nullah
    and currently wet.

    Generating plain road points here did not work: of 15,146 sampled
    road points in one real zone, none of the top-ranked ones satisfied
    "within 15m of the nullah AND trunk/primary/secondary AND backing
    up", so drainBlockageClearance could never be proposed. This
    generates against the validator's own requirements instead of
    hoping a general road sample happens to satisfy them.
    """
    import response_validation_drainage as RVD
    import prevention_validation as PV
    import flood_engine
    from shapely.geometry import Point
    from prevention_validation import line_length_m, interpolate_line_m

    waterways = ctx.get("waterways_geojson")
    if not waterways:
        waterways = flood_engine.load_waterways()
        ctx["waterways_geojson"] = waterways

    high_cap = set(RVD.RULES["CULVERT_HIGH_CAPACITY_CLASSES"])
    max_ww = RVD.RULES["CULVERT_WATERWAY_MAX_M"]

    out = []
    for feature in (ctx["roads_geojson"] or {}).get("features", []):
        geom = feature.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        props = feature.get("properties") or {}
        hw = props.get("highway")
        if isinstance(hw, list):
            hw = hw[0] if hw else None
        if hw not in high_cap:
            continue
        coords = geom.get("coordinates") or []
        length_m = line_length_m(coords)
        if length_m <= 0:
            continue
        steps = max(1, round(length_m / 25))
        for i in range(steps + 1):
            lon, lat = interpolate_line_m(coords, (i / steps) * length_m)
            if not _point_in_bbox(lon, lat, zone_bbox):
                continue
            depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
            if depth is None or depth <= 0:
                continue
            d = PV.nearest_line_distance_m(Point(lon, lat), waterways)
            if d is None or d > max_ww:
                continue
            out.append({
                "id": len(out), "lon": lon, "lat": lat,
                "descriptor": f"{props.get('name') or 'Unnamed'} {hw} culvert crossing, {depth:.1f}m of water, {round(d)}m from the nullah",
            })
    return out


def _waterway_candidates(zone_bbox, ctx):
    """Points sampled along the real mapped nullah -- where a footbridge
    or informal crossing over the channel would actually be."""
    import flood_engine
    from prevention_validation import line_length_m, interpolate_line_m

    ww = ctx.get("waterways_geojson")
    if not ww:
        ww = flood_engine.load_waterways()
        ctx["waterways_geojson"] = ww

    out = []
    for f in ww.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") != "LineString":
            continue
        coords = g.get("coordinates") or []
        L = line_length_m(coords)
        if L <= 0:
            continue
        steps = max(1, round(L / 60))
        name = (f.get("properties") or {}).get("name") or "Unnamed nullah"
        for i in range(steps + 1):
            lon, lat = interpolate_line_m(coords, (i / steps) * L)
            if not _point_in_bbox(lon, lat, zone_bbox):
                continue
            out.append({
                "id": len(out), "lon": lon, "lat": lat,
                "descriptor": f"Crossing over {name}, {round((i / steps) * L)}m along this reach",
            })
    return out


def _dry_grid_candidates(zone_bbox, ctx, spacing_m=100):
    """The inverse of _wet_grid_candidates -- grid points the depth grid
    shows as DRY. A dam-release rally point has to be ground the surge
    cannot reach, so wet candidates are useless for it."""
    w, s, e, n = zone_bbox
    lat_mid = (s + n) / 2
    m_per_deg_lon = 111320 * math.cos(math.radians(lat_mid))
    step_lat = spacing_m / 111320
    step_lon = spacing_m / max(m_per_deg_lon, 1e-6)

    out = []
    lat = s + step_lat / 2
    while lat <= n:
        lon = w + step_lon / 2
        while lon <= e:
            depth = depth_at_point(lat, lon, ctx["depth_grid"], ctx["depth_meta"])
            if depth is None or depth <= 0:
                out.append({
                    "id": len(out), "lon": lon, "lat": lat,
                    "descriptor": "Dry ground, above the modelled surge",
                })
            lon += step_lon
        lat += step_lat
    return out


def _dry_facility_candidates(amenity_types, zone_bbox, ctx):
    """Shelter-type facilities on DRY ground only.

    Relief camps and medical posts are validated against exactly this:
    a post inside the flood extent is refused, correctly -- you cannot
    site a camp in 12m of water. But the generator offered every
    facility in the bbox regardless, so at high water levels almost the
    whole shortlist was pre-doomed and relief/medical coverage sat at 0%
    for every run. The dry sites existed all along (187 of 354 at
    545m); they were simply never offered.

    Falls back to the nearest DRY facilities when the zone's own bbox
    contains none, same rule the other generators use.
    """
    def coord_of(f):
        props = f.get("properties") or {}
        if props.get("amenity") not in amenity_types:
            return None
        c = _feature_centroid(f)
        if c is None:
            return None
        from response_validation import point_on_safe_ground, distance_m as _dm

        # Apply the SAME hard requirements the validator will, so the
        # shortlist is made of sites that can actually be accepted:
        #   1. on safe ground -- dry AND clear of the flood edge
        #      (SAFE_GROUND_CLEARANCE_M), not merely dry
        #   2. within serving distance of an evacuation zone that
        #      already exists in this plan
        # Filtering only on "not under water" still produced a shortlist
        # where every option failed, just with a different reason.
        ground = point_on_safe_ground(c[1], c[0], ctx["depth_grid"], ctx["depth_meta"])
        if not ground.get("ok") or not ground.get("safe"):
            return None

        from response_validation import RULES as _R

        zones = ctx.get("existing_evac_zones") or []
        if zones:
            nearest = min(_dm(c[0], c[1], z["lon"], z["lat"]) for z in zones)
            if nearest > _R["EVAC_ZONE_EXISTS_MAX_M"]:
                return None

        # 3. Road-accessible. A relief post has to be reachable by
        #    vehicle -- the validator refuses anything not on an open
        #    road, which was the last reason a pre-filtered, dry,
        #    well-cleared site still got rejected live.
        road = nearest_road(c[1], c[0], _R["ROAD_SNAP_MAX_M"], ctx["roads_geojson"])
        if not road.get("found"):
            return None
        return (c[0], c[1])

    def describe(f):
        p = f.get("properties") or {}
        return f"{p.get('name') or 'Unnamed ' + str(p.get('amenity'))} ({p.get('amenity')}), on dry ground"

    return _collect_with_fallback(zone_bbox, (ctx["facilities_geojson"] or {}).get("features", []), describe, coord_of)
