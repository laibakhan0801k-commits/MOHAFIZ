"""
PREVENTION ACTION VALIDATION CONSTANTS -- CANONICAL SOURCE OF TRUTH.

Mirrored manually in Frontend/mohafizweb/src/components/PlanWorkspace.js.
Every constant here has a matching "// SYNC: prevention_constants.py <NAME>"
comment on its JS counterpart -- WATERWAY_SNAP_MAX_M and the four
EMBANKMENT_* constants are standalone JS constants; everything under
ACTION_VALIDATION_CONFIG mirrors the inline `validationConfig` object on
each entry of PlanWorkspace.js's PREVENTION_TOOLS array (there is no
standalone JS constant for e.g. green buffer's distance band -- it only
ever existed as `validationConfig: { minWaterwayDistance: 5, ... }` on
that one array entry, so this file's ACTION_VALIDATION_CONFIG dict is
its Python-side equivalent). Search both files for "SYNC:" to find every
paired value. If you change a value here, you MUST update the matching
JS value, and vice versa.

Last synced: 2026-09-03 (ported directly from the real PlanWorkspace.js
source at that date -- not from an earlier illustrative draft of this
spec, which had guessed some of these values slightly wrong; verify
against PlanWorkspace.js again if this file and that file ever
visibly disagree).
"""

# ---------------------------------------------------------------------
# Standalone JS constants (PlanWorkspace.js top-level `const`s)
# ---------------------------------------------------------------------

# Real channel width (~3m) + click/zoom tolerance. Used by
# findNearestWaterwaySegment() for the three actions that only need a
# "is this click on the waterway" check (desilt, clearDrains,
# warningGauge) -- see WATERWAY_SNAP_ACTIONS below.
WATERWAY_SNAP_MAX_M = 30

# Embankment-specific constants (used by the full-line validation --
# checkPointConstraints / validateEmbankmentLine in PlanWorkspace.js).
EMBANKMENT_MIN_DISTANCE_M = 5
EMBANKMENT_MAX_DISTANCE_M = 50
EMBANKMENT_ROAD_BUFFER_M = 15
EMBANKMENT_SAMPLE_INTERVAL_M = 5
# Hardcoded inline in checkPointConstraints() rather than its own named
# JS constant, but still a real paired value -- see the SYNC comment on
# that function's `buildingClearance: 10,` line.
EMBANKMENT_BUILDING_CLEARANCE_M = 10

# ---------------------------------------------------------------------
# Per-action validationConfig, mirroring PREVENTION_TOOLS entries EXACTLY
# (PlanWorkspace.js lines ~735-919, key: 'desilt' | 'clearDrains' |
# 'embankment' | 'widenChannel' | 'removeEncroachment' | 'retentionPond'
# | 'warningGauge' | 'greenBuffer'). This is the dict passed as `config`
# to validatePlacement(lngLat, config, geoData) for each action type --
# check_point_constraints() in prevention_validation.py takes the same
# shape. Action-type strings are camelCase to match PlanWorkspace.js's
# PREVENTION_TOOLS `key` values exactly (and main.py's
# _build_terrain_args, which switches on these same strings) -- there
# is no snake_case variant anywhere in the real codebase.
# ---------------------------------------------------------------------
ACTION_VALIDATION_CONFIG = {
    "desilt": {},              # waterway-snap only, via WATERWAY_SNAP_MAX_M
    "clearDrains": {},         # waterway-snap only
    "warningGauge": {},        # waterway-snap only
    "embankment": {
        "minWaterwayDistance": EMBANKMENT_MIN_DISTANCE_M,
        "maxWaterwayDistance": EMBANKMENT_MAX_DISTANCE_M,
        "roadClearance": EMBANKMENT_ROAD_BUFFER_M,
        "buildingClearance": EMBANKMENT_BUILDING_CLEARANCE_M,
    },
    "widenChannel": {
        "minWaterwayDistance": 0,
        "maxWaterwayDistance": 30,
        "roadClearance": 0,
        "requireNoBuildingNearby": 10,
    },
    "removeEncroachment": {
        "minWaterwayDistance": 0,
        "maxWaterwayDistance": 15,
        "roadClearance": 0,
        "requireOnBuilding": True,
        "excludeAmenities": [
            "school", "college", "university", "hospital", "clinic",
            "doctors", "place_of_worship", "government",
        ],
    },
    "retentionPond": {
        "minWaterwayDistance": 10,
        "maxWaterwayDistance": 100,
        "roadClearance": 15,
        "buildingClearance": 10,
        "checkExistingWater": True,
    },
    "greenBuffer": {
        "minWaterwayDistance": 5,
        "maxWaterwayDistance": 40,
        "roadClearance": 15,
        "buildingClearance": 10,
    },
}

# Actions validated via the waterway-snap check (findNearestWaterwaySegment)
# instead of validatePlacement's config-driven checks -- their
# ACTION_VALIDATION_CONFIG entry is intentionally empty.
WATERWAY_SNAP_ACTIONS = ("desilt", "clearDrains", "warningGauge")

# Every real prevention action key, in PREVENTION_TOOLS's own order.
# SYNC: PlanWorkspace.js PREVENTION_KEYS (line ~4578)
ALL_ACTION_TYPES = (
    "desilt", "clearDrains", "embankment", "widenChannel",
    "removeEncroachment", "retentionPond", "warningGauge", "greenBuffer",
)

# ---------------------------------------------------------------------
# main.py _build_terrain_args() defaults -- these are NOT click-validation
# constants, they're the real terrain-modification parameters the
# backend actually applies, some of which are hardcoded server-side
# regardless of what the frontend form (or an AI proposal) sends. A
# proposed action's "real_impact" is only real if compute_real_impact()
# uses these same numbers.
# ---------------------------------------------------------------------
RETENTION_POND_DEFAULT_DEPTH_M = 2       # SYNC: main.py _build_terrain_args 'retentionPond' (params.depth_m/depth default)
RETENTION_POND_DEFAULT_AREA_M2 = 2000    # SYNC: main.py _build_terrain_args 'retentionPond' (params.surface_area_m2/area default)
ENCROACHMENT_REMOVAL_RADIUS_M = 7        # SYNC: main.py _build_terrain_args 'removeEncroachment' (hardcoded, not form-configurable)
ENCROACHMENT_REMOVAL_DEPTH_M = 2         # SYNC: main.py _build_terrain_args 'removeEncroachment' (hardcoded, not form-configurable)
WIDEN_CHANNEL_DEPTH_M = 0.5              # SYNC: main.py _build_terrain_args 'widenChannel' (hardcoded, always 0.5m regardless of form input)

# ---------------------------------------------------------------------
# Part -1 -- cause-type -> ordered action-type preference. NOT a hard
# restriction, just the order the Proposer tries candidate action types
# in per priority zone, grounded in flood_engine.py's own real
# cause-effect calibration:
#   - drainage_failure is specifically local drainage CAPACITY being
#     overwhelmed (see flood_engine.drainage_failure_severity) -- desilt/
#     clearDrains/widenChannel address that mechanism directly.
#   - river_overflow / dam_release are both a real channel water-LEVEL
#     rise (river_overflow_severity, dam release logic) -- embankment/
#     widenChannel address that mechanism.
#   - rainfall is broader: both overland runoff AND channel capacity
#     matter (see rainfall_band_severity / the volume-conserving model),
#     so it gets the widest pool.
#
# Every entry below is checked against PlanWorkspace.js's own
# PREVENTION_TOOLS[*].causeTypes -- the manual click UI's real per-
# scenario action list -- so the AI can never try (or be missing) an
# action a human placing one by hand wouldn't see for this cause_type.
# The previous version of this table predated a few of those tools and
# had drifted: "rainfall" listed "embankment" (not a real rainfall
# option; causeTypes=['river_overflow','dam_release']) while missing
# "clearDrains"/"widenChannel" (real rainfall options it never got to
# try), and "dam_release" listed "widenChannel" the same way
# (causeTypes=['rainfall','river_overflow','drainage_failure'] --
# dam_release isn't in it). All four rows below are now the exact real
# action set for that cause_type, high-impact/structural actions first.
# ---------------------------------------------------------------------
CAUSE_TYPE_ACTION_WEIGHTS = {
    "drainage_failure": ["desilt", "clearDrains", "widenChannel", "retentionPond", "warningGauge"],
    "river_overflow": ["embankment", "widenChannel", "removeEncroachment", "retentionPond", "greenBuffer", "warningGauge"],
    "dam_release": ["embankment", "removeEncroachment", "retentionPond", "greenBuffer", "warningGauge"],
    "rainfall": ["retentionPond", "greenBuffer", "desilt", "clearDrains", "widenChannel"],
}
