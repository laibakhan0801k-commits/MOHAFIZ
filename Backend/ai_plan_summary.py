"""
AI RESPONSE PLAN -- zone breakdown, real impact totals, and a plan
confidence score.

Every number here is COMPUTED from the same real layers the rest of the
app already reads (the depth grid, buildings.geojson, the accepted
proposals and their real validated placements). Nothing on this page is
asked of the LLM, and nothing is invented.

Deliberately NOT computed, because this project has no model that could
honestly produce them: lives saved, minutes of response time saved, and
"damage reduced %". Those need mortality / evacuation-timing / asset-
value models that do not exist here. The real equivalents used instead
are people in covered buildings (buildings x the same
PEOPLE_PER_BUILDING_ESTIMATE the coverage maths already uses), buildings
covered, and how many identified risk zones the plan actually reaches.

CONFIDENCE is a transparent composite of real signals, never a model's
self-assessment. It ships with its own factor breakdown so the number is
always explainable rather than a black box -- see plan_confidence().
"""
import response_validation as RV

PEOPLE_PER_BUILDING = RV.PEOPLE_PER_BUILDING_ESTIMATE


def _bbox_center(bbox):
    w, s, e, n = bbox
    return ((s + n) / 2.0, (w + e) / 2.0)


def _bbox_radius_m(bbox):
    """Half the bbox diagonal, in meters -- the radius that covers the
    whole zone from its center, so a zone's own building count is
    measured over the real zone, not an arbitrary fixed circle."""
    w, s, e, n = bbox
    lat, lon = _bbox_center(bbox)
    dx = RV.distance_m(w, lat, e, lat)
    dy = RV.distance_m(lon, s, lon, n)
    return max(1.0, (dx ** 2 + dy ** 2) ** 0.5 / 2.0)


def zone_exposure(zone, ctx):
    """Real exposure for one hazard zone: how many buildings sit inside
    it, the estimated people in them, and the worst water depth found.
    All measured from the real layers, none of it from the model."""
    bbox = zone.get("bbox")
    if not bbox or len(bbox) != 4:
        return {"buildings": 0, "people": 0, "max_depth_m": 0.0, "radius_m": 0}

    lat, lon = _bbox_center(bbox)
    radius = _bbox_radius_m(bbox)
    buildings = RV.count_buildings_within(lat, lon, radius, ctx["buildings_geojson"])
    scan = RV.scan_depth_near(lat, lon, radius, ctx["depth_grid"], ctx["depth_meta"])
    return {
        "buildings": buildings,
        "people": round(buildings * PEOPLE_PER_BUILDING),
        "max_depth_m": round(scan.get("max_depth_m") or 0.0, 1),
        "radius_m": round(radius),
    }


def risk_level(exposure):
    """Plain-language band from the two real drivers the simulation
    already measures: how deep the water gets in the zone, and how many
    buildings are exposed to it. Thresholds are stated here rather than
    hidden so the label can be defended."""
    depth = exposure["max_depth_m"]
    buildings = exposure["buildings"]
    if depth >= 3.0 and buildings >= 100:
        return "critical"
    if depth >= 1.5 and buildings >= 25:
        return "high"
    if depth >= 0.5 or buildings >= 10:
        return "medium"
    return "low"


def build_zone_breakdown(zones, proposals, ctx):
    """One entry per real priority zone: its measured exposure, its risk
    band, and the real accepted actions the plan placed in it."""
    by_zone = {}
    for p in proposals:
        by_zone.setdefault(p.get("zone_description"), []).append(p)

    out = []
    for i, zone in enumerate(zones):
        exposure = zone_exposure(zone, ctx)
        actions = by_zone.get(zone.get("description"), [])
        out.append({
            "zone_index": i,
            "description": zone.get("description"),
            "bbox": zone.get("bbox"),
            "risk_level": risk_level(exposure),
            "buildings_at_risk": exposure["buildings"],
            "population_at_risk": exposure["people"],
            "max_depth_m": exposure["max_depth_m"],
            "already_covered": bool(zone.get("covered")),
            "actions": [
                {
                    "action_type": a.get("action_type"),
                    "location": a.get("location"),
                    "reasoning": a.get("ai_reasoning"),
                    "real_coverage": a.get("real_coverage"),
                }
                for a in actions
            ],
        })
    return out


def plan_confidence(zone_breakdown, trace, comparison):
    """A transparent composite of REAL signals -- not the model's own
    opinion of itself.

    Three factors, each a genuine measurement:
      * zones_addressed  -- of the real priority zones found, how many
        did the plan actually place an action in? A plan that leaves
        half the identified risk untouched should not read as confident.
      * placement_validity -- of every placement attempted, how many
        passed the SAME real rules a human click faces? Rejections are
        counted from the real trace, not assumed.
      * coverage_gain -- did the plan actually move real coverage, and
        by how much, relative to what was still uncovered.

    Returned WITH its factors so the UI can always show why the number
    is what it is. A score with no visible basis would be exactly the
    invented-number problem this module exists to avoid.
    """
    total_zones = len(zone_breakdown) or 1
    zones_with_actions = sum(1 for z in zone_breakdown if z["actions"])
    zones_score = zones_with_actions / total_zones

    accepted = sum(1 for e in trace if e.get("event") == "accepted")
    rejected = sum(1 for e in trace if e.get("event") == "rejected")
    attempts = accepted + rejected
    validity_score = (accepted / attempts) if attempts else 0.0

    gain = 0.0
    if comparison:
        before, after = comparison.get("before") or {}, comparison.get("after") or {}
        gains = []
        for key in ("evacuation", "warning", "rescue", "relief"):
            b = (before.get(key) or {}).get("percent")
            a = (after.get(key) or {}).get("percent")
            if isinstance(b, (int, float)) and isinstance(a, (int, float)):
                headroom = 100.0 - b
                if headroom > 0:
                    gains.append(max(0.0, (a - b)) / headroom)
        if gains:
            gain = sum(gains) / len(gains)

    # Weighted so "did we actually address the risk we found" dominates,
    # and a plan that placed nothing can never score high.
    score = (zones_score * 0.5) + (validity_score * 0.3) + (gain * 0.2)
    if zones_with_actions == 0:
        score = 0.0

    return {
        "score": round(score * 100),
        "factors": [
            {
                "label": "Risk zones addressed",
                "value": f"{zones_with_actions} of {total_zones}",
                "detail": "Priority zones the plan placed at least one real action in.",
            },
            {
                "label": "Placements passing validation",
                "value": (f"{accepted} of {attempts}" if attempts else "n/a"),
                "detail": "Checked against the same placement rules a manual click faces.",
            },
            {
                "label": "Coverage gained",
                "value": f"{round(gain * 100)}% of what was reachable",
                "detail": "Real before/after coverage change, measured by the Impact Evaluator.",
            },
        ],
    }


def overall_impact(zone_breakdown, comparison):
    """Plan-level totals, all real. Uses buildings actually covered by
    the placed actions (from the Impact Evaluator's own real counts)
    rather than any modelled casualty or damage figure."""
    after = (comparison or {}).get("after") or {}
    before = (comparison or {}).get("before") or {}

    total_at_risk = (comparison or {}).get("total_buildings")
    if total_at_risk is None:
        total_at_risk = sum(z["buildings_at_risk"] for z in zone_breakdown)

    def pct(key):
        v = (after.get(key) or {}).get("percent")
        return v if isinstance(v, (int, float)) else 0

    best_pct = max(pct("evacuation"), pct("warning"), pct("rescue"), pct("relief"))
    buildings_covered = round((best_pct / 100.0) * (total_at_risk or 0))

    return {
        "buildings_at_risk": total_at_risk,
        "buildings_covered": buildings_covered,
        "people_in_covered_buildings": round(buildings_covered * PEOPLE_PER_BUILDING),
        "zones_addressed": sum(1 for z in zone_breakdown if z["actions"]),
        "zones_total": len(zone_breakdown),
        "coverage_before": {
            "evacuation": (before.get("evacuation") or {}).get("percent", 0),
            "warning": (before.get("warning") or {}).get("percent", 0),
            "rescue": (before.get("rescue") or {}).get("percent", 0),
            "relief": (before.get("relief") or {}).get("percent", 0),
        },
        "coverage_after": {
            "evacuation": pct("evacuation"),
            "warning": pct("warning"),
            "rescue": pct("rescue"),
            "relief": pct("relief"),
        },
    }


def build_plan_summary(zones, proposals, trace, comparison, ctx):
    """Single entry point the endpoint calls."""
    zone_breakdown = build_zone_breakdown(zones, proposals, ctx)
    return {
        "zones": zone_breakdown,
        "confidence": plan_confidence(zone_breakdown, trace, comparison),
        "overall": overall_impact(zone_breakdown, comparison),
    }
