'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

const SCENARIO_META = {
  rainfall:         { emoji: '🌧️', label: 'Rainfall',         color: '#0EA5E9', description: 'Surface runoff from heavy rain' },
  river_overflow:   { emoji: '🌊', label: 'River Overflow',   color: '#06B6D4', description: 'Water level crossing the banks' },
  drainage_failure: { emoji: '🕳️', label: 'Drainage Failure', color: '#F59E0B', description: 'Drains cannot carry incoming water' },
  dam_release:      { emoji: '🚰', label: 'Dam Release',      color: '#8B5CF6', description: 'Downstream surge from dam release' },
};

function filterToolsByCauseType(tools, causeType) {
  if (!causeType) return tools;
  return tools.filter(function (t) { return !t.causeTypes || t.causeTypes.indexOf(causeType) >= 0; });
}

const RESPONSE_TOOLS = [
  { key: 'closeRoad', label: 'Close flooded road', emoji: '🚧', color: '#dc2626', kind: 'road', hint: 'Click any red flooded road to close it to traffic' },
  { key: 'boatLaunch', label: 'Boat launch point', emoji: '🛟', color: '#0ea5e9', kind: 'point', hint: 'Click where rescue boats should be deployed from' },
  { key: 'reliefCamp', label: 'Relief camp / shelter', emoji: '🏕️', color: '#16a34a', kind: 'point', hint: 'Click a safe high-ground site for displaced families' },
  { key: 'medicalPost', label: 'Medical / first-aid post', emoji: '🚑', color: '#e11d48', kind: 'point', hint: 'Click where a field medical post should be set up' },
  { key: 'evacuationZone', label: 'Priority evacuation zone', emoji: '⚠️', color: '#7c3aed', kind: 'point', hint: 'Click an area that must be evacuated first' },
  { key: 'warningPoint', label: 'Warning announcement point', emoji: '📢', color: '#f59e0b', kind: 'point', hint: 'Click a mosque or public point for loudspeaker warnings' },
  { key: 'dewatering', label: 'Dewatering pump', emoji: '💧', color: '#0891b2', kind: 'point', hint: 'Click where pumps should drain standing water' },
  { key: 'supplyPoint', label: 'Food & water distribution', emoji: '🍲', color: '#ca8a04', kind: 'point', hint: 'Click a reachable point for relief supply distribution' },
  { key: 'helipad', label: 'Helicopter landing zone', emoji: '🚁', color: '#475569', kind: 'point', hint: 'Click open, dry ground suitable for helicopter landing' },
  { key: 'diversion', label: 'Traffic diversion point', emoji: '↩️', color: '#8b5cf6', kind: 'point', hint: 'Click where traffic should be redirected away from water' },
];

const PREVENTION_TOOLS = [
  {
    key: 'desilt',
    label: 'Desilt nullah section',
    causeTypes: ['rainfall', 'drainage_failure'],
    emoji: '🪣',
    color: '#0891b2',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line where silt needs removing — clicks off the waterway are rejected',
    effect: {},
    effectLabel: 'Removes accumulated silt — restores designed channel depth',
    realBasis: 'Real precedent: in 2020, govt approved Rs40M specifically to desilt Nullah Leh + 10 other nullahs. Officials predicted a 12ft water-level rise if it did NOT happen.',
    validationConfig: {},
    formFields: [
      { key: 'length', label: 'Length', type: 'number', min: 10, max: 500, step: 10, unit: 'm', default: 100 },
      { key: 'depthToRemove', label: 'Depth to remove', type: 'number', min: 0.2, max: 3, step: 0.1, unit: 'm', default: 0.5 },
    ],
  },
  {
    key: 'clearDrains',
    label: 'Clear blocked drains',
    causeTypes: ['rainfall', 'drainage_failure'],
    emoji: '🕳️',
    color: '#f59e0b',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line near the blocked section — clicks off the waterway are rejected',
    effect: {},
    effectLabel: 'Clears blockage — restores original drain capacity',
    realBasis: 'Real context: local drains in this region are commonly designed for only 12-25mm/hr — blockage removes what little headroom exists.',
    validationConfig: {},
    formFields: [
      { key: 'sectionLength', label: 'Section length', type: 'number', min: 5, max: 200, step: 5, unit: 'm', default: 30 },
    ],
  },
  {
    key: 'embankment',
    label: 'Build / raise embankment',
    causeTypes: ['river_overflow', 'dam_release'],
    emoji: '🧱',
    color: '#78350f',
    kind: 'point',
    targetType: 'embankment',
    hint: 'Click on the BANK near the nullah (5-50m away) — not on the channel, a building, or a road',
    effect: {},
    effectLabel: 'Real before/after flood comparison using terrain physics',
    realBasis: 'Standard flood-engineering countermeasure; the embankment physically raises terrain and the flood engine re-runs on the modified DEM to show real impact.',
    validationConfig: {
      minWaterwayDistance: 5,
      maxWaterwayDistance: 50,
      roadClearance: 15,
      buildingClearance: 10,
    },
    formFields: [
      { key: 'length', label: 'Length', type: 'number', min: 10, max: 300, step: 10, unit: 'm', default: 50 },
      { key: 'height', label: 'Height', type: 'number', min: 0.5, max: 5, step: 0.1, unit: 'm', default: 1.5 },
      { key: 'material', label: 'Material', type: 'select', options: [
        { value: 'earthen', label: 'Earthen bund' },
        { value: 'concrete', label: 'Concrete wall' },
        { value: 'sandbag', label: 'Sandbag barrier' },
      ], default: 'earthen' },
    ],
    submitLabel: 'Check feasibility & add',
  },
  {
    key: 'widenChannel',
    label: 'Widen channel section',
    causeTypes: ['rainfall', 'river_overflow', 'drainage_failure'],
    emoji: '📏',
    color: '#0284c7',
    kind: 'point',
    targetType: 'waterwayWithRoom',
    hint: 'Click ON the blue nullah line at a section with open banks — rejects if buildings are within 10m (no room to widen)',
    effect: {},
    effectLabel: 'Real channel widening (validation ensures physical feasibility)',
    realBasis: 'Standard hydraulic principle (wider channel = more flow capacity); validation checks that buildings don\'t block widening before accepting placement.',
    validationConfig: {
      minWaterwayDistance: 0,
      maxWaterwayDistance: 30,
      roadClearance: 0,
      requireNoBuildingNearby: 10,
    },
    formFields: [
      { key: 'newWidth', label: 'New channel width', type: 'number', min: 3, max: 30, step: 0.5, unit: 'm', default: 8 },
      { key: 'length', label: 'Section length', type: 'number', min: 10, max: 300, step: 10, unit: 'm', default: 50 },
    ],
  },
  {
    key: 'removeEncroachment',
    label: 'Remove encroachment',
    causeTypes: ['river_overflow', 'dam_release'],
    emoji: '🏚️',
    color: '#b91c1c',
    kind: 'point',
    targetType: 'building',
    hint: 'Click ON a building within 15m of the nullah — excludes schools, hospitals, mosques, colleges, government buildings',
    effect: {},
    effectLabel: 'Real building removal (validation ensures it\'s actually encroaching)',
    realBasis: 'Real finding: Islamabad E-11 nullah had 40ft right-of-way illegally narrowed to 18ft, causing flooding and 2 deaths. Officials blamed encroachment for worsening Aug 2026 floods.',
    validationConfig: {
      minWaterwayDistance: 0,
      maxWaterwayDistance: 15,
      roadClearance: 0,
      requireOnBuilding: true,
      excludeAmenities: ['school', 'college', 'university', 'hospital', 'clinic', 'doctors', 'place_of_worship', 'government'],
    },
    formFields: [],
  },
  {
    key: 'retentionPond',
    label: 'Retention pond',
    causeTypes: ['rainfall', 'river_overflow', 'drainage_failure', 'dam_release'],
    emoji: '🌊',
    color: '#0d9488',
    kind: 'point',
    targetType: 'openLand',
    hint: 'Click open land 10-100m from the nullah — not on buildings, roads, or existing water bodies',
    effect: {},
    effectLabel: 'Real water storage (validation ensures feasible location)',
    realBasis: 'Same principle real dams (Rawal, Khanpur, Simly) use to hold back water — validation ensures the pond isn\'t placed on top of an existing lake or structure.',
    validationConfig: {
      minWaterwayDistance: 10,
      maxWaterwayDistance: 100,
      roadClearance: 15,
      buildingClearance: 10,
      checkExistingWater: true,
    },
    formFields: [
      { key: 'area', label: 'Surface area', type: 'number', min: 100, max: 50000, step: 50, unit: 'm²', default: 2000 },
      { key: 'depth', label: 'Depth', type: 'number', min: 0.5, max: 6, step: 0.1, unit: 'm', default: 2 },
    ],
  },
  {
    key: 'warningGauge',
    label: 'Community alert point',
    causeTypes: ['river_overflow', 'drainage_failure', 'dam_release'],
    emoji: '🔊',
    color: '#7c3aed',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line where a siren / loudspeaker should be installed',
    effect: {},
    effectLabel: 'Earlier warning for residents — no reduction in flood depth',
    realBasis: 'A real system already exists: the Leh Nullah Flood Forecasting & Warning System (JICA, since 2007) — sirens + mosque loudspeakers. This measure represents extending that real coverage upstream into this corridor.',
    validationConfig: {},
    formFields: [
      { key: 'warningLevelM', label: 'Warning water level', type: 'number', min: 0.5, max: 10, step: 0.1, unit: 'm', default: 2 },
      { key: 'alertType', label: 'Alert type', type: 'select', options: [
        { value: 'siren', label: 'Siren' },
        { value: 'mosque_loudspeaker', label: 'Mosque loudspeaker' },
        { value: 'sms_cascade', label: 'SMS cascade' },
        { value: 'manual_flag', label: 'Manual flag system' },
      ], default: 'siren' },
    ],
  },
  {
    key: 'greenBuffer',
    label: 'Green buffer / plantation',
    causeTypes: ['rainfall', 'river_overflow', 'dam_release'],
    emoji: '🌳',
    color: '#16a34a',
    kind: 'point',
    targetType: 'riparianZone',
    hint: 'Click open land 5-40m from the nullah bank — not on buildings or roads',
    effect: {},
    effectLabel: 'Real riparian buffer (validation ensures it\'s beside the water)',
    realBasis: 'Standard hydrology principle (vegetation slows runoff); validation ensures the buffer is actually beside the channel where it can intercept flow.',
    validationConfig: {
      minWaterwayDistance: 5,
      maxWaterwayDistance: 40,
      roadClearance: 15,
      buildingClearance: 10,
    },
    formFields: [
      { key: 'bufferWidth', label: 'Buffer width', type: 'number', min: 2, max: 50, step: 1, unit: 'm', default: 10 },
      { key: 'vegetationType', label: 'Vegetation type', type: 'select', options: [
        { value: 'native_trees', label: 'Native trees' },
        { value: 'grass_reeds', label: 'Grass & reeds' },
        { value: 'mixed_shrub', label: 'Mixed shrub' },
        { value: 'bamboo', label: 'Bamboo' },
      ], default: 'native_trees' },
    ],
  },
];

// ---------------------------------------------------------------------
// Real click-to-target validation for waterway-based prevention actions.
// Snaps a click to the nearest real waterway segment (from
// waterways.geojson, loaded on the map) and rejects it if too far away.
// This stops "desilt the nullah" from silently accepting a click on a
// road or an empty field -- the click must land on a real channel.
// ---------------------------------------------------------------------
const WATERWAY_SNAP_MAX_M = 30; // real channel width (~3m) + click/zoom tolerance

function findNearestWaterwaySegment(lngLat, waterwaysGeoJSON, maxDistanceM) {
  if (!waterwaysGeoJSON || !waterwaysGeoJSON.features || waterwaysGeoJSON.features.length === 0) {
    return { accepted: false, reason: 'Waterway data not loaded yet — try again in a moment.' };
  }

  const clickPoint = turf.point([lngLat.lng, lngLat.lat]);
  const nearest = turf.nearestPointOnLine(waterwaysGeoJSON, clickPoint, { units: 'meters' });

  const distanceM = nearest.properties.dist;

  if (distanceM > maxDistanceM) {
    return {
      accepted: false,
      reason: 'That point is ' + Math.round(distanceM) + 'm from the nearest nullah — click closer to the blue line.',
      distanceM: distanceM,
    };
  }

  const featureIndex = nearest.properties.multiFeatureIndex;
  const sourceFeature = waterwaysGeoJSON.features[featureIndex];
  const coords = nearest.geometry.coordinates;

  return {
    accepted: true,
    distanceM: distanceM,
    lng: coords[0],
    lat: coords[1],
    segmentName: (sourceFeature && sourceFeature.properties && sourceFeature.properties.name) || 'Unnamed waterway section',
    waterwayId: sourceFeature && sourceFeature.properties && sourceFeature.properties.id,
  };
}

// Embankment-specific constants (used by the full-line validation)
const EMBANKMENT_MIN_DISTANCE_M = 5;
const EMBANKMENT_MAX_DISTANCE_M = 50;
const EMBANKMENT_ROAD_BUFFER_M = 15;
const EMBANKMENT_SAMPLE_INTERVAL_M = 5;

// ---------------------------------------------------------------------
// Generalized placement validation for prevention actions.
// Each action passes a config object specifying its constraints:
//   - minWaterwayDistance: meters from nullah (0 = on the channel)
//   - maxWaterwayDistance: meters from nullah (how far is "near enough")
//   - roadClearance: meters from nearest road
//   - buildingClearance: meters from Point-geometry buildings (conservative)
//   - checkExistingWater: reject if on existing water body
//   - requireOnBuilding: click must land on a building polygon
//   - excludeAmenities: array of amenity tags that can't be flagged
//   - requireNoBuildingNearby: meters - reject if any building closer than this
//
// This is the single source of truth for what makes a placement valid.
// Every prevention action calls this with its own config.
// ---------------------------------------------------------------------

function validatePlacement(lngLat, config, geoData) {
  const { waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON, waterBodiesGeoJSON } = geoData;
  const clickPoint = turf.point([lngLat.lng, lngLat.lat]);

  // Building checks
  if (buildingsGeoJSON && buildingsGeoJSON.features) {
    // Check if click is inside a Polygon/MultiPolygon building
    for (const feature of buildingsGeoJSON.features) {
      const geomType = feature.geometry && feature.geometry.type;
      
      if (geomType === 'Point' && config.buildingClearance) {
        // Point buildings: use distance check (we don't know their real footprint)
        const distance = turf.distance(clickPoint, feature, { units: 'meters' });
        if (distance < config.buildingClearance) {
          return { ok: false, reason: 'is only ' + Math.round(distance) + 'm from a building' };
        }
      } else if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
        if (turf.booleanPointInPolygon(clickPoint, feature)) {
          if (config.requireOnBuilding) {
            // For remove encroachment: this is GOOD, we want to be on a building
            // But check if it's an excluded amenity
            const amenity = feature.properties && feature.properties.amenity;
            if (config.excludeAmenities && amenity && config.excludeAmenities.includes(amenity)) {
              return { ok: false, reason: 'is a ' + amenity + ' — can\'t flag essential infrastructure as encroachment' };
            }
            // Return the building feature so the caller knows which one was clicked
            return { ok: true, clickedBuilding: feature };
          } else {
            return { ok: false, reason: 'falls inside a building footprint' };
          }
        }
      }
    }
    
    // If we require being on a building but didn't find one, reject
    if (config.requireOnBuilding) {
      return { ok: false, reason: 'doesn\'t land on a building — click directly on a structure' };
    }
  }

  // Road checks
  if (roadsGeoJSON && roadsGeoJSON.features && roadsGeoJSON.features.length > 0 && config.roadClearance > 0) {
    const nearestRoad = turf.nearestPointOnLine(roadsGeoJSON, clickPoint, { units: 'meters' });
    if (nearestRoad.properties.dist < config.roadClearance) {
      return { ok: false, reason: 'is only ' + Math.round(nearestRoad.properties.dist) + 'm from a road' };
    }
  }

  // Waterway distance checks
  if (config.minWaterwayDistance !== undefined || config.maxWaterwayDistance !== undefined) {
    if (!waterwaysGeoJSON || !waterwaysGeoJSON.features || waterwaysGeoJSON.features.length === 0) {
      return { ok: false, reason: 'can\'t be checked against the nullah (data not loaded yet)' };
    }

    const nearestWaterway = turf.nearestPointOnLine(waterwaysGeoJSON, clickPoint, { units: 'meters' });
    const waterwayDistanceM = nearestWaterway.properties.dist;

    if (config.minWaterwayDistance > 0 && waterwayDistanceM < config.minWaterwayDistance) {
      return { ok: false, reason: 'is only ' + Math.round(waterwayDistanceM) + 'm from the nullah — inside the channel itself' };
    }
    if (config.maxWaterwayDistance > 0 && waterwayDistanceM > config.maxWaterwayDistance) {
      return { ok: false, reason: 'is ' + Math.round(waterwayDistanceM) + 'm from the nearest nullah — too far' };
    }
  }

  // Existing water body check (for retention pond)
  if (config.checkExistingWater && waterBodiesGeoJSON && waterBodiesGeoJSON.features) {
    for (const feature of waterBodiesGeoJSON.features) {
      if (turf.booleanPointInPolygon(clickPoint, feature)) {
        return { ok: false, reason: 'is already on an existing water body — no need to build a pond here' };
      }
    }
  }

  // Building proximity check (for widen channel - is there room to widen?)
  if (config.requireNoBuildingNearby && buildingsGeoJSON && buildingsGeoJSON.features) {
    for (const feature of buildingsGeoJSON.features) {
      const geomType = feature.geometry && feature.geometry.type;
      if (geomType === 'Point') {
        const distance = turf.distance(clickPoint, feature, { units: 'meters' });
        if (distance < config.requireNoBuildingNearby) {
          return { ok: false, reason: 'has a building only ' + Math.round(distance) + 'm away — no room to widen without demolition' };
        }
      } else if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
        const distance = turf.pointToLineDistance(clickPoint, feature, { units: 'meters' });
        if (distance < config.requireNoBuildingNearby) {
          return { ok: false, reason: 'has a building only ' + Math.round(distance) + 'm away — no room to widen without demolition' };
        }
      }
    }
  }

  return { ok: true };
}

// Legacy wrapper for backward compatibility with existing embankment code
function checkPointConstraints(point, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON) {
  const config = {
    minWaterwayDistance: EMBANKMENT_MIN_DISTANCE_M,
    maxWaterwayDistance: EMBANKMENT_MAX_DISTANCE_M,
    roadClearance: EMBANKMENT_ROAD_BUFFER_M,
    buildingClearance: 10,
  };
  const geoData = { waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON };
  const lngLat = { lng: point.geometry.coordinates[0], lat: point.geometry.coordinates[1] };
  return validatePlacement(lngLat, config, geoData);
}

function validateEmbankmentPlacement(lngLat, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON) {
  const clickPoint = turf.point([lngLat.lng, lngLat.lat]);
  const check = checkPointConstraints(clickPoint, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON);
  if (!check.ok) {
    return { accepted: false, reason: 'That point ' + check.reason + '.' };
  }

  const nearestWaterway = turf.nearestPointOnLine(waterwaysGeoJSON, clickPoint, { units: 'meters' });
  return {
    accepted: true,
    lng: lngLat.lng,
    lat: lngLat.lat,
    waterwayDistanceM: nearestWaterway.properties.dist,
  };
}

// Orients the wall PARALLEL to the nullah at this point (how a real
// levee is actually built) by using the bearing of the nearest real
// waterway segment, then extends lengthM/2 in each direction from the
// anchor -- the anchor becomes the line's midpoint.
function buildEmbankmentLine(anchorLng, anchorLat, lengthM, waterwaysGeoJSON) {
  if (!waterwaysGeoJSON || !waterwaysGeoJSON.features || waterwaysGeoJSON.features.length === 0) {
    return null;
  }

  const anchorPoint = turf.point([anchorLng, anchorLat]);

  // Find which feature is closest first (multiFeatureIndex is reliable
  // here -- already proven correct by the waterway-snap actions).
  const nearestOverall = turf.nearestPointOnLine(waterwaysGeoJSON, anchorPoint, { units: 'meters' });
  const featureIndex = nearestOverall.properties.multiFeatureIndex;
  const sourceFeature = waterwaysGeoJSON.features[featureIndex];
  if (!sourceFeature || !sourceFeature.geometry || sourceFeature.geometry.type !== 'LineString') {
    return null;
  }

  // Re-run nearestPointOnLine scoped to JUST that single feature -- this
  // is what makes 'index' unambiguous. Running it against the whole
  // FeatureCollection gave an index that didn't reliably map back into
  // this feature's own coordinates array (caused an out-of-bounds crash).
  const singleLine = turf.lineString(sourceFeature.geometry.coordinates);
  const nearestOnFeature = turf.nearestPointOnLine(singleLine, anchorPoint, { units: 'meters' });
  const segmentIndex = nearestOnFeature.properties.index;

  const coords = sourceFeature.geometry.coordinates;
  let segStart = coords[segmentIndex];
  let segEnd = coords[segmentIndex + 1];
  if (!segStart || !segEnd) {
    // Right at an endpoint -- fall back to the feature's overall
    // start-to-end direction rather than crashing.
    segStart = coords[0];
    segEnd = coords[coords.length - 1];
  }
  if (!segStart || !segEnd || (segStart[0] === segEnd[0] && segStart[1] === segEnd[1])) {
    return null; // degenerate line, can't determine a direction here
  }

  const bearing = turf.bearing(turf.point(segStart), turf.point(segEnd));
  const halfKm = (lengthM / 2) / 1000;
  const endA = turf.destination(anchorPoint, halfKm, bearing, { units: 'kilometers' });
  const endB = turf.destination(anchorPoint, halfKm, bearing + 180, { units: 'kilometers' });

  return { lineCoords: [endA.geometry.coordinates, endB.geometry.coordinates] };
}

// Checks the WHOLE proposed wall, not just the anchor -- samples every
// ~5m along its length and runs the same checkPointConstraints used for
// the single-click check, so a long wall can't sneak past by having
// only its (already-validated) anchor checked.
function validateEmbankmentLine(lineCoords, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON) {
  const line = turf.lineString(lineCoords);
  const totalLengthKm = turf.length(line, { units: 'kilometers' });
  const totalLengthM = totalLengthKm * 1000;
  const numSamples = Math.max(2, Math.ceil(totalLengthM / EMBANKMENT_SAMPLE_INTERVAL_M));

  for (let i = 0; i <= numSamples; i++) {
    const distKm = (i / numSamples) * totalLengthKm;
    const samplePoint = turf.along(line, distKm, { units: 'kilometers' });
    const check = checkPointConstraints(samplePoint, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON);
    if (!check.ok) {
      const positionM = Math.round(distKm * 1000);
      return {
        accepted: false,
        reason: 'At ' + positionM + 'm along the wall from your click point, it ' + check.reason + '. Try a shorter length or a different location.',
      };
    }
  }

  return { accepted: true };
}

// ---------------------------------------------------------------------
// Generic helpers for the config-driven prevention action flow.
// ---------------------------------------------------------------------

var _nextUid = 1;
function nextUid() { return _nextUid++; }

function buildDefaultForms() {
  const defaults = {};
  PREVENTION_TOOLS.forEach(function (tool) {
    if (!tool.formFields) return;
    const form = {};
    tool.formFields.forEach(function (f) { form[f.key] = f.default; });
    defaults[tool.key] = form;
  });
  return defaults;
}

function resolvePlacement(lngLat, toolDef, geoData) {
  const { waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON } = geoData;

  // Embankment uses its own dedicated validator
  if (toolDef.targetType === 'embankment') {
    const result = validateEmbankmentPlacement(lngLat, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON);
    if (!result.accepted) return { accepted: false, reason: result.reason };
    return { accepted: true, payload: { lng: result.lng, lat: result.lat, waterwayDistanceM: result.waterwayDistanceM } };
  }

  // Simple waterway snap (desilt, clearDrains, warningGauge)
  if (toolDef.targetType === 'waterway') {
    const result = findNearestWaterwaySegment(lngLat, waterwaysGeoJSON, WATERWAY_SNAP_MAX_M);
    if (!result.accepted) return { accepted: false, reason: result.reason };
    return { accepted: true, payload: { lng: result.lng, lat: result.lat, targetSegmentName: result.segmentName, targetWaterwayId: result.waterwayId, waterwayDistanceM: result.distanceM } };
  }

  // All other types use the generalized validatePlacement
  const config = toolDef.validationConfig || {};
  const check = validatePlacement(lngLat, config, geoData);
  if (!check.ok) return { accepted: false, reason: 'That point ' + check.reason + '.' };

  // waterwayWithRoom also snaps to the waterway line
  if (toolDef.targetType === 'waterwayWithRoom') {
    const result = findNearestWaterwaySegment(lngLat, waterwaysGeoJSON, 30);
    return { accepted: true, payload: { lng: result.lng, lat: result.lat, targetSegmentName: result.segmentName, targetWaterwayId: result.waterwayId, waterwayDistanceM: result.distanceM } };
  }

  // building type carries the clicked building feature
  if (toolDef.targetType === 'building') {
    return { accepted: true, payload: { lng: lngLat.lng, lat: lngLat.lat, clickedBuilding: check.clickedBuilding } };
  }

  // road type snaps to the nearest road segment
  if (toolDef.targetType === 'road') {
    if (!roadsGeoJSON) return { accepted: false, reason: 'Road data is not available.' };
    var roadPt = turf.point([lngLat.lng, lngLat.lat]);
    var nearestRoad = turf.nearestPointOnLine(roadsGeoJSON, roadPt, { units: 'meters' });
    if (nearestRoad.properties.dist > 20) {
      return { accepted: false, reason: 'No road within 20m of that point. Click directly on a road segment.' };
    }
    var roadIdx = nearestRoad.properties.index || 0;
    var roadFeature = roadsGeoJSON.features[roadIdx];
    var highwayType = roadFeature && roadFeature.properties && roadFeature.properties.highway;
    if (Array.isArray(highwayType)) highwayType = highwayType[0];
    return {
      accepted: true,
      payload: {
        lng: nearestRoad.geometry.coordinates[0],
        lat: nearestRoad.geometry.coordinates[1],
        snappedToRoad: true,
        roadHighwayType: highwayType || 'road',
        roadDistanceM: Math.round(nearestRoad.properties.dist),
      },
    };
  }

  // waterwayBank behaves like waterwayWithRoom — validate + snap to waterway
  if (toolDef.targetType === 'waterwayBank') {
    var wwResult = findNearestWaterwaySegment(lngLat, waterwaysGeoJSON, 30);
    if (!wwResult.accepted) return { accepted: false, reason: wwResult.reason };
    return { accepted: true, payload: { lng: wwResult.lng, lat: wwResult.lat, targetSegmentName: wwResult.segmentName, targetWaterwayId: wwResult.waterwayId, waterwayDistanceM: wwResult.distanceM } };
  }

  // openLand, riparianZone, customPoint — use raw click coords
  return { accepted: true, payload: { lng: lngLat.lng, lat: lngLat.lat } };
}

function buildMarker(toolDef, payload, params, planType) {
  const marker = {
    _uid: nextUid(),
    planType: planType,
    type: toolDef.key,
    label: toolDef.label,
    emoji: toolDef.emoji,
    color: toolDef.color,
    effect: toolDef.effect || {},
    effectLabel: toolDef.effectLabel || null,
    lat: payload.lat,
    lon: payload.lng,
  };
  if (payload.targetSegmentName) marker.targetSegmentName = payload.targetSegmentName;
  if (payload.targetWaterwayId) marker.targetWaterwayId = payload.targetWaterwayId;
  if (payload.clickedBuilding) marker.clickedBuilding = payload.clickedBuilding;
  if (params) marker.params = params;
  if (payload.customLabel) { marker.label = payload.customLabel; marker.isCustom = true; }
  return marker;
}

function formatParams(toolDef, params) {
  if (!params || !toolDef.formFields) return null;
  const parts = [];
  toolDef.formFields.forEach(function (f) {
    const val = params[f.key];
    if (val === undefined || val === null) return;
    if (f.type === 'select') {
      const opt = f.options.find(function (o) { return o.value === val; });
      parts.push(f.label + ': ' + (opt ? opt.label : val));
    } else {
      parts.push(val + (f.unit ? f.unit : '') + ' ' + f.label.toLowerCase());
    }
  });
  return parts.length > 0 ? parts.join(', ') : null;
}

// ---------------------------------------------------------------------
// Smart "Other Action" keyword matcher.
// ---------------------------------------------------------------------

const ACTION_SYNONYMS = {
  // Existing prevention tools
  desilt: ['desilt', 'mud', 'sediment', 'silt', 'dredge', 'dig', 'excavate'],
  clearDrains: ['drain', 'blocked', 'clear', 'unclog', 'choke', 'debris', 'clean drain'],
  embankment: ['embankment', 'levee', 'raise bank', 'bund', 'barrier along'],
  widenChannel: ['widen', 'broaden', 'expand channel', 'narrow', 'channel width'],
  removeEncroachment: ['encroachment', 'illegal', 'demolish', 'structure blocking', 'remove building'],
  retentionPond: ['pond', 'reservoir', 'storage', 'detention', 'retention', 'hold water'],
  warningGauge: ['warning', 'alert', 'siren', 'monitor', 'loudspeaker', 'warn', 'announce'],
  greenBuffer: ['green', 'tree', 'plant', 'vegetation', 'buffer', 'mangrove', 'plantation'],
  // Custom actions
  raiseRoad: ['raise road', 'elevate road', 'road height', 'road higher', 'lift road', 'road level', 'raise this road', 'road by'],
  floodProofRoad: ['flood proof', 'floodproof', 'waterproof road', 'road protection', 'harden road', 'protect road', 'flood-proof'],
  drainageChannel: ['drainage channel', 'drain channel', 'new channel', 'build channel', 'dig channel', 'drainage path'],
  floodBarrier: ['flood barrier', 'barrier', 'flood wall', 'stop water', 'water barrier', 'flood defence'],
};

var PREVENTION_KEYS = ['desilt', 'clearDrains', 'embankment', 'widenChannel', 'removeEncroachment', 'retentionPond', 'warningGauge', 'greenBuffer'];

function extractParams(text) {
  var params = {};
  var labeled = /(?:height|width|depth|length|long|wide|deep)\s*[:=]?\s*(\d+\.?\d*)\s*m(?:eters?)?\b/gi;
  var m;
  while ((m = labeled.exec(text)) !== null) {
    var labelMatch = text.substring(Math.max(0, m.index - 20), m.index + m[0].indexOf(m[1])).match(/(height|width|depth|length|long|wide|deep)/i);
    if (labelMatch) {
      var key = labelMatch[1].toLowerCase();
      if (key === 'long') key = 'length';
      if (key === 'wide') key = 'width';
      if (key === 'deep') key = 'depth';
      params[key] = parseFloat(m[1]);
    }
  }
  if (Object.keys(params).length === 0) {
    var bare = text.match(/(\d+\.?\d*)\s*m(?:eters?)?\b/i);
    if (bare) params.value = parseFloat(bare[1]);
  }
  return params;
}

function matchCustomAction(text, causeType) {
  if (!text) return { toolKey: null };
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var extractedParams = extractParams(text);

  // Build allowed keys from scenario cause type
  var allowedKeys = null;
  if (causeType) {
    allowedKeys = {};
    PREVENTION_TOOLS.forEach(function (t) {
      if (!t.causeTypes || t.causeTypes.indexOf(causeType) >= 0) allowedKeys[t.key] = true;
    });
    CUSTOM_ACTIONS.forEach(function (a) {
      if (!a.causeTypes || a.causeTypes.indexOf(causeType) >= 0) allowedKeys[a.key] = true;
    });
  }

  let best = null;
  let runnerUp = null;

  Object.keys(ACTION_SYNONYMS).forEach(function (toolKey) {
    if (allowedKeys && !allowedKeys[toolKey]) return;
    let score = 0;
    const matched = [];
    ACTION_SYNONYMS[toolKey].forEach(function (keyword) {
      if (keyword.indexOf(' ') >= 0) {
        if (normalized.indexOf(keyword) >= 0) { score += 2; matched.push(keyword); }
      } else {
        var re = new RegExp('\\b' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (re.test(normalized)) { score += 1; matched.push(keyword); }
      }
    });
    if (score > 0) {
      var source = PREVENTION_KEYS.indexOf(toolKey) >= 0 ? 'prevention' : 'custom';
      var entry = { toolKey: toolKey, score: score, matchedTerms: matched, source: source };
      if (!best || score > best.score) {
        if (best) runnerUp = best;
        best = entry;
      } else if (!runnerUp || score > runnerUp.score) {
        runnerUp = entry;
      }
    }
  });

  if (!best || best.score < 1) return { toolKey: null };
  best.extractedParams = extractedParams;
  if (runnerUp) runnerUp.extractedParams = extractedParams;
  if (runnerUp && best.score - runnerUp.score <= 1) {
    return Object.assign({}, best, { runnerUp: runnerUp });
  }
  return best;
}

// Custom action pseudo-tool for user-defined interventions
var CUSTOM_ACTION_TOOL = {
  key: 'customAction',
  label: 'Custom action',
  emoji: '✍️',
  color: '#475569',
  kind: 'point',
  targetType: 'customPoint',
  validationConfig: { checkExistingWater: true },
  formFields: [],
  hint: 'Click where this action should happen — not on a water body',
};

var CUSTOM_ACTIONS = [
  {
    key: 'raiseRoad',
    label: 'Raise road',
    causeTypes: ['rainfall', 'drainage_failure', 'dam_release'],
    emoji: '🛣️',
    color: '#d97706',
    kind: 'point',
    targetType: 'road',
    validationConfig: { roadClearance: 5, buildingClearance: 5, checkExistingWater: true },
    formFields: [
      { key: 'height', label: 'Raise height', type: 'number', min: 0.2, max: 5, step: 0.1, unit: 'm', default: 1 },
      { key: 'length', label: 'Road section length', type: 'number', min: 10, max: 500, step: 10, unit: 'm', default: 100 },
    ],
    effectLabel: 'Raises road surface above flood level',
    hint: 'Click on a ROAD segment to raise',
  },
  {
    key: 'floodProofRoad',
    label: 'Flood-proof road',
    causeTypes: ['rainfall', 'drainage_failure', 'dam_release'],
    emoji: '🛡️',
    color: '#0369a1',
    kind: 'point',
    targetType: 'road',
    validationConfig: { roadClearance: 5, buildingClearance: 5, checkExistingWater: true },
    formFields: [
      { key: 'length', label: 'Section length', type: 'number', min: 10, max: 500, step: 10, unit: 'm', default: 100 },
    ],
    effectLabel: 'Hardens road surface against flood damage',
    hint: 'Click on a ROAD segment to flood-proof',
  },
  {
    key: 'drainageChannel',
    label: 'Build drainage channel',
    causeTypes: ['rainfall', 'drainage_failure'],
    emoji: '🔧',
    color: '#0284c7',
    kind: 'point',
    targetType: 'openLand',
    validationConfig: { minWaterwayDistance: 5, maxWaterwayDistance: 200, roadClearance: 5, buildingClearance: 10, checkExistingWater: true },
    formFields: [
      { key: 'width', label: 'Channel width', type: 'number', min: 0.5, max: 10, step: 0.5, unit: 'm', default: 2 },
      { key: 'depth', label: 'Channel depth', type: 'number', min: 0.3, max: 5, step: 0.1, unit: 'm', default: 1 },
      { key: 'length', label: 'Channel length', type: 'number', min: 10, max: 500, step: 10, unit: 'm', default: 50 },
    ],
    effectLabel: 'New channel to redirect excess water',
    hint: 'Click on OPEN LAND where a drainage channel should be dug',
  },
  {
    key: 'floodBarrier',
    label: 'Build flood barrier',
    causeTypes: ['river_overflow', 'dam_release'],
    emoji: '🧱',
    color: '#92400e',
    kind: 'point',
    targetType: 'waterwayBank',
    validationConfig: { minWaterwayDistance: 2, maxWaterwayDistance: 30, roadClearance: 5, buildingClearance: 10 },
    formFields: [
      { key: 'height', label: 'Barrier height', type: 'number', min: 0.5, max: 5, step: 0.1, unit: 'm', default: 1.5 },
      { key: 'length', label: 'Barrier length', type: 'number', min: 10, max: 300, step: 10, unit: 'm', default: 50 },
    ],
    effectLabel: 'Physical barrier along waterway bank',
    hint: 'Click near a WATERWAY bank where a barrier should be built',
  },
];

var ANIMATION_SEQUENCES = {
  desilt: {
    phases: [
      { emoji: '🪣', text: 'Clearing silt\u2026' },
      { emoji: '🪣💪', text: 'Working\u2026' },
      { emoji: '✅', text: 'Channel cleaned' },
    ],
    phaseMs: 1000,
  },
  clearDrains: {
    phases: [
      { emoji: '🕳️', text: 'Unblocking drain\u2026' },
      { emoji: '🔧', text: 'Removing debris\u2026' },
      { emoji: '✅', text: 'Drain clear' },
    ],
    phaseMs: 1000,
  },
  embankment: {
    phases: [
      { emoji: '📍', text: 'Setting out line\u2026' },
      { emoji: '🧱', text: 'Building wall\u2026' },
      { emoji: '✅', text: 'Embankment built' },
    ],
    phaseMs: 1000,
  },
  widenChannel: {
    phases: [
      { emoji: '⛏️', text: 'Excavating bank\u2026' },
      { emoji: '🚜', text: 'Widening channel\u2026' },
      { emoji: '✅', text: 'Channel widened' },
    ],
    phaseMs: 1000,
  },
  removeEncroachment: {
    phases: [
      { emoji: '🏗️', text: 'Demolishing\u2026' },
      { emoji: '✅', text: 'Structure removed' },
    ],
    phaseMs: 1000,
  },
  retentionPond: {
    phases: [
      { emoji: '📍', text: 'Marking site\u2026' },
      { emoji: '🕳️', text: 'Excavating\u2026' },
      { emoji: '🌊', text: 'Pond created' },
    ],
    phaseMs: 1000,
  },
  warningGauge: {
    phases: [
      { emoji: '📡', text: 'Installing\u2026' },
      { emoji: '🔊', text: 'Alert point active' },
    ],
    phaseMs: 1000,
  },
  greenBuffer: {
    phases: [
      { emoji: '👷', text: 'Planting\u2026' },
      { emoji: '🌱', text: 'Seedlings placed\u2026' },
      { emoji: '🌳', text: 'Buffer established' },
    ],
    phaseMs: 1000,
  },
  customAction: {
    phases: [
      { emoji: '📌', text: 'Applied' },
    ],
    phaseMs: 1500,
  },
  raiseRoad: {
    phases: [
      { emoji: '🛣️', text: 'Raising road\u2026' },
      { emoji: '🚜', text: 'Elevating surface\u2026' },
      { emoji: '✅', text: 'Road raised' },
    ],
    phaseMs: 1000,
  },
  floodProofRoad: {
    phases: [
      { emoji: '🛡️', text: 'Hardening road\u2026' },
      { emoji: '✅', text: 'Road flood-proofed' },
    ],
    phaseMs: 1200,
  },
  drainageChannel: {
    phases: [
      { emoji: '🔧', text: 'Digging channel\u2026' },
      { emoji: '🚜', text: 'Excavating\u2026' },
      { emoji: '✅', text: 'Channel built' },
    ],
    phaseMs: 1000,
  },
  floodBarrier: {
    phases: [
      { emoji: '🧱', text: 'Building barrier\u2026' },
      { emoji: '👷', text: 'Constructing\u2026' },
      { emoji: '✅', text: 'Barrier complete' },
    ],
    phaseMs: 1000,
  },
  responseDefault: {
    phases: [
      { emoji: '📌', text: 'Placed' },
    ],
    phaseMs: 1500,
  },
};

function playInterventionAnimation(map, toolKey, lng, lat) {
  if (!map) return;
  var seq = ANIMATION_SEQUENCES[toolKey] || ANIMATION_SEQUENCES.customAction;
  var phases = seq.phases;
  var phaseMs = seq.phaseMs;

  var container = document.createElement('div');
  container.style.pointerEvents = 'none';
  container.style.textAlign = 'center';
  container.style.transition = 'opacity 0.4s ease';
  container.style.opacity = '1';

  var pill = document.createElement('div');
  pill.style.background = 'rgba(15, 23, 42, 0.88)';
  pill.style.borderRadius = '12px';
  pill.style.padding = '8px 14px 10px';
  pill.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
  pill.style.minWidth = '100px';

  var emojiDiv = document.createElement('div');
  emojiDiv.style.fontSize = '32px';
  emojiDiv.style.lineHeight = '1.1';
  emojiDiv.textContent = phases[0].emoji;

  var textDiv = document.createElement('div');
  textDiv.style.fontSize = '12px';
  textDiv.style.fontWeight = '600';
  textDiv.style.color = '#ffffff';
  textDiv.style.marginTop = '4px';
  textDiv.style.whiteSpace = 'nowrap';
  textDiv.textContent = phases[0].text;

  pill.appendChild(emojiDiv);
  pill.appendChild(textDiv);
  container.appendChild(pill);

  var marker = new maplibregl.Marker({ element: container, anchor: 'bottom' })
    .setLngLat([lng, lat])
    .addTo(map);

  var phaseIndex = 1;
  function showNextPhase() {
    if (phaseIndex >= phases.length) {
      container.style.opacity = '0';
      setTimeout(function () { marker.remove(); }, 450);
      return;
    }
    emojiDiv.textContent = phases[phaseIndex].emoji;
    textDiv.textContent = phases[phaseIndex].text;
    phaseIndex++;
    setTimeout(showNextPhase, phaseMs);
  }

  setTimeout(showNextPhase, phaseMs);
}

export default function PlanWorkspace() {
  const router = useRouter();
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const waterwaysDataRef = useRef(null);
  const buildingsDataRef = useRef(null);
  const roadsDataRef = useRef(null);
  const waterBodiesDataRef = useRef(null);

  const [scenario, setScenario] = useState(null);
  const [status, setStatus] = useState('loading scenario...');
  const [planType, setPlanType] = useState('response');
  const [activeTool, setActiveTool] = useState(null);
  const [closedRoads, setClosedRoads] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [customNotes, setCustomNotes] = useState([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [startPoint, setStartPoint] = useState(null);
  const [unreachableHospitals, setUnreachableHospitals] = useState([]);
  const [routeInfo, setRouteInfo] = useState(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [destinationPoint, setDestinationPoint] = useState(null);
  const [toolError, setToolError] = useState(null);
  const [embankments, setEmbankments] = useState([]);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionForms, setActionForms] = useState(buildDefaultForms);
  const [noteMatch, setNoteMatch] = useState(null);
  const [pendingCustomAction, setPendingCustomAction] = useState(null);
  const [undoStack, setUndoStack] = useState([]);

  const activeToolRef = useRef(null);
  const planTypeRef = useRef('response');
  const startPointRef = useRef(null);
  const pendingCustomActionRef = useRef(null);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { planTypeRef.current = planType; }, [planType]);
  useEffect(() => { startPointRef.current = startPoint; }, [startPoint]);
  useEffect(() => { pendingCustomActionRef.current = pendingCustomAction; }, [pendingCustomAction]);

  var causeType = scenario && scenario.cause_type;
  const TOOLS = planType === 'response' ? RESPONSE_TOOLS : filterToolsByCauseType(PREVENTION_TOOLS, causeType);

  useEffect(() => {
    const raw = sessionStorage.getItem('mohafiz_scenario');
    if (!raw) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser-only sessionStorage after mount, deliberately deferred to avoid SSR/CSR hydration mismatch
      setStatus('No scenario found. Run a simulation first.');
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser-only sessionStorage after mount, deliberately deferred to avoid SSR/CSR hydration mismatch
    setScenario(JSON.parse(raw));
  }, []);

  // Auto-check EVERY affected hospital as soon as a start point is set —
  // no manual clicking required. Unreachable ones get marked with a ✕.
  useEffect(() => {
    if (!startPoint || !scenario) return;
    let cancelled = false;

    async function checkAll() {
      setCheckingAccess(true);
      setUnreachableHospitals([]);
      setRouteInfo(null);
      setDestinationPoint(null);

      const map = mapRef.current;
      if (map && map.getSource('route-direct')) {
        map.getSource('route-direct').setData({ type: 'FeatureCollection', features: [] });
      }
      if (map && map.getSource('route-safe')) {
        map.getSource('route-safe').setData({ type: 'FeatureCollection', features: [] });
      }

      const hospitals = scenario.affected_facilities.filter(function (f) {
        return ['hospital', 'clinic', 'doctors'].indexOf(f.amenity) !== -1;
      });

      const results = await Promise.all(hospitals.map(async function (h) {
        try {
          const res = await fetch(API_URL + '/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              start_lat: startPoint.lat,
              start_lon: startPoint.lon,
              end_lat: h.lat,
              end_lon: h.lon,
              water_level_m: scenario.water_level_m,
            }),
          });
          const data = await res.json();
          return { name: h.name, lat: h.lat, lon: h.lon, reachable: data.reachable !== false };
        } catch (err) {
          return { name: h.name, lat: h.lat, lon: h.lon, reachable: true };
        }
      }));

      if (cancelled) return;

      const unreachable = results.filter(function (r) { return !r.reachable; });
      setUnreachableHospitals(unreachable);
      setCheckingAccess(false);
    }

    checkAll();
    return function () { cancelled = true; };
  }, [startPoint, scenario]);

  async function runRoute(destLat, destLon, destinationName) {
    const start = startPointRef.current;
    if (!start) {
      alert('Set a start point first — pick "Set start point" from the Routing panel, then click the map.');
      return;
    }

    setRouteInfo({ loading: true, hospitalName: destinationName });

    try {
      const res = await fetch(API_URL + '/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: start.lat,
          start_lon: start.lon,
          end_lat: destLat,
          end_lon: destLon,
          water_level_m: scenario.water_level_m,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Route failed');

      const map = mapRef.current;

      map.getSource('route-direct').setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: data.direct_route },
        }],
      });

      if (data.reachable && data.crosses_flood && data.safe_route) {
        map.getSource('route-safe').setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: data.safe_route },
          }],
        });
      } else {
        map.getSource('route-safe').setData({ type: 'FeatureCollection', features: [] });
      }

      setDestinationPoint({ lat: destLat, lon: destLon, reachable: data.reachable });

      setRouteInfo({
        loading: false,
        hospitalName: destinationName,
        crossesFlood: data.crosses_flood,
        reachable: data.reachable,
        directLengthM: data.direct_length_m,
        safeLengthM: data.safe_length_m,
      });
    } catch (err) {
      setRouteInfo({ loading: false, hospitalName: destinationName, error: err.message });
    }
  }

  useEffect(() => {
    if (!scenario || mapRef.current) return;

    const fw = scenario.flooded_bbox[0];
    const fs = scenario.flooded_bbox[1];
    const fe = scenario.flooded_bbox[2];
    const fn = scenario.flooded_bbox[3];

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm-raster': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm-raster-layer', type: 'raster', source: 'osm-raster' }],
      },
      bounds: [[fw, fs], [fe, fn]],
      fitBoundsOptions: { padding: 40 },
      pitch: 45,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));

    mapRef.current.on('load', async () => {
      const map = mapRef.current;
      const w = scenario.flood_image_bounds[0];
      const s = scenario.flood_image_bounds[1];
      const e = scenario.flood_image_bounds[2];
      const n = scenario.flood_image_bounds[3];

      map.addSource('flood-overlay', {
        type: 'image',
        url: scenario.flood_image,
        coordinates: [[w, n], [e, n], [e, s], [w, s]],
      });
      map.addLayer({
        id: 'flood-overlay-layer',
        type: 'raster',
        source: 'flood-overlay',
        paint: { 'raster-opacity': 0.55 },
      });

      try {
        const waterways = await (await fetch('/data/waterways.geojson')).json();
        waterwaysDataRef.current = waterways;
        map.addSource('waterways', { type: 'geojson', data: waterways });
        map.addLayer({
          id: 'waterways-line',
          type: 'line',
          source: 'waterways',
          paint: { 'line-color': '#0284c7', 'line-width': 3, 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: 'waterways-label',
          type: 'symbol',
          source: 'waterways',
          filter: ['has', 'name'],
          layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'name'],
            'text-size': 12,
          },
          paint: {
            'text-color': '#0284c7',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
          },
        });
      } catch (err) {
        console.error('waterways failed', err);
      }

      try {
        const buildings = await (await fetch('/data/buildings.geojson')).json();
        buildingsDataRef.current = buildings;
        map.addSource('buildings', { type: 'geojson', data: buildings });
        map.addLayer({
          id: 'buildings-3d',
          type: 'fill-extrusion',
          source: 'buildings',
          paint: {
            'fill-extrusion-color': [
              'case',
              ['<=', ['coalesce', ['get', 'base_elevation_m'], 9999], scenario.water_level_m],
              '#7f1d1d',
              '#94a3b8',
            ],
            'fill-extrusion-height': [
              'case',
              ['!=', ['get', 'height'], null],
              ['to-number', ['get', 'height'], 6],
              ['!=', ['get', 'building:levels'], null],
              ['*', ['to-number', ['get', 'building:levels'], 2], 2.5],
              6,
            ],
            'fill-extrusion-opacity': 0.75,
          },
        });
      } catch (err) {
        console.error('buildings failed', err);
      }

      // Full road network, used only for embankment placement validation
      // (reject clicks too close to a road) -- not rendered as a visible
      // layer to avoid cluttering the existing flooded-roads display.
      try {
        const roads = await (await fetch('/data/roads.geojson')).json();
        roadsDataRef.current = roads;
      } catch (err) {
        console.error('roads.geojson failed (embankment road-check will be skipped)', err);
      }

      // Water bodies, used only for retention pond placement validation
      // (reject clicks on existing lakes/ponds) -- not rendered as a visible layer.
      try {
        const waterBodies = await (await fetch('/data/water_bodies.geojson')).json();
        waterBodiesDataRef.current = waterBodies;
      } catch (err) {
        console.error('water_bodies.geojson failed (retention pond check will be skipped)', err);
      }

      const roadFeatures = scenario.flooded_roads.map(function (coords, i) {
        return {
          type: 'Feature',
          properties: { roadIndex: i, closed: false },
          geometry: { type: 'LineString', coordinates: coords },
        };
      });

      map.addSource('flooded-roads', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: roadFeatures },
      });

      map.addLayer({
        id: 'flooded-roads-layer',
        type: 'line',
        source: 'flooded-roads',
        paint: {
          'line-color': ['case', ['get', 'closed'], '#111827', '#dc2626'],
          'line-width': ['case', ['get', 'closed'], 6, 3],
          'line-opacity': 0.9,
        },
      });

      map.addLayer({
        id: 'flooded-roads-hit',
        type: 'line',
        source: 'flooded-roads',
        paint: { 'line-color': '#000000', 'line-width': 16, 'line-opacity': 0 },
      });

      const facilityFeatures = scenario.affected_facilities.map(function (f) {
        return {
          type: 'Feature',
          properties: { name: f.name, amenity: f.amenity },
          geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        };
      });
      map.addSource('affected-facilities', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: facilityFeatures },
      });
      map.addLayer({
        id: 'affected-facilities-layer',
        type: 'circle',
        source: 'affected-facilities',
        paint: {
          'circle-radius': 7,
          'circle-color': '#dc2626',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.on('click', 'affected-facilities-layer', function (ev) {
        const p = ev.features[0].properties;
        const coords = ev.features[0].geometry.coordinates;
        const popupId = 'route-btn-' + Math.round(coords[0] * 100000) + '-' + Math.round(coords[1] * 100000);

        const popup = new maplibregl.Popup()
          .setLngLat(ev.lngLat)
          .setHTML(
            '<div style="min-width:160px">' +
            '<strong>' + p.name + '</strong><br/>' +
            '<span style="color:#64748b">' + p.amenity + ' — affected</span><br/>' +
            '<button id="' + popupId + '" style="margin-top:8px;width:100%;padding:6px;border:none;border-radius:8px;background:#2563eb;color:white;font-weight:700;font-size:12px;cursor:pointer;">🚑 Show route</button>' +
            '</div>'
          )
          .addTo(map);

        setTimeout(function () {
          const btn = document.getElementById(popupId);
          if (btn) {
            btn.addEventListener('click', function () {
              runRoute(coords[1], coords[0], p.name);
              popup.remove();
            });
          }
        }, 0);
      });

      map.addSource('plan-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'plan-markers-layer',
        type: 'circle',
        source: 'plan-markers',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'markerType'], 'retentionPond'], 18,
            11,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addSource('embankment-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'embankment-lines-outline',
        type: 'line',
        source: 'embankment-lines',
        paint: { 'line-color': '#ffffff', 'line-width': 16, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'embankment-lines-layer',
        type: 'line',
        source: 'embankment-lines',
        paint: { 'line-color': '#78350f', 'line-width': 10, 'line-dasharray': [1, 0.3] },
      });

      map.addSource('start-point', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'start-point-layer',
        type: 'circle',
        source: 'start-point',
        paint: {
          'circle-radius': 10,
          'circle-color': '#2563eb',
          'circle-stroke-width': 4,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addSource('route-direct', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-direct-outline',
        type: 'line',
        source: 'route-direct',
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'route-direct-line',
        type: 'line',
        source: 'route-direct',
        paint: { 'line-color': '#ff6a00', 'line-width': 5 },
      });

      map.addSource('route-safe', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-safe-outline',
        type: 'line',
        source: 'route-safe',
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'route-safe-line',
        type: 'line',
        source: 'route-safe',
        paint: {
          'line-color': '#00c853',
          'line-width': 5,
          'line-dasharray': [2, 1.5],
        },
      });

      map.addSource('unreachable-hospitals', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'unreachable-hospitals-layer',
        type: 'symbol',
        source: 'unreachable-hospitals',
        layout: {
          'text-field': '✕',
          'text-size': 26,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 3.5,
        },
      });

      map.addSource('destination-marker', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'destination-marker-layer',
        type: 'symbol',
        source: 'destination-marker',
        layout: {
          'text-field': ['case', ['get', 'reachable'], '✓', '✕'],
          'text-size': 28,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['case', ['get', 'reachable'], '#16a34a', '#000000'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 4,
        },
      });

      map.on('click', 'flooded-roads-hit', function (ev) {
        if (activeToolRef.current !== 'closeRoad') return;
        ev.preventDefault();
        const idx = ev.features[0].properties.roadIndex;
        var roadUid = nextUid();
        setClosedRoads(function (prev) {
          var alreadyClosed = prev.some(function (r) { return r.roadIndex === idx; });
          if (alreadyClosed) return prev;
          return prev.concat([{ roadIndex: idx, _uid: roadUid }]);
        });
        setUndoStack(function (prev) { return prev.concat([{ type: 'closedRoad', uid: roadUid }]); });
      });

      map.on('mouseenter', 'flooded-roads-hit', function () {
        if (activeToolRef.current === 'closeRoad') map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'flooded-roads-hit', function () {
        map.getCanvas().style.cursor = '';
      });

      map.on('click', function (ev) {
        const toolKey = activeToolRef.current;

        if (toolKey === 'setStart') {
          setStartPoint({ lat: ev.lngLat.lat, lon: ev.lngLat.lng });
          return;
        }

        if (toolKey === 'closeRoad') return;

        if (toolKey) {
          var clickCauseType = scenario && scenario.cause_type;
          const pool = planTypeRef.current === 'response' ? RESPONSE_TOOLS : filterToolsByCauseType(PREVENTION_TOOLS, clickCauseType);
          const toolDef = pool.find(function (t) { return t.key === toolKey; });

          // Check if this is a custom action from CUSTOM_ACTIONS registry
          var customActionDef = CUSTOM_ACTIONS.find(function (a) { return a.key === toolKey; });
          // Legacy custom action pseudo-tool
          var pca = pendingCustomActionRef.current;
          const isLegacyCustom = toolKey === 'customAction' && pca;
          const effectiveToolDef = customActionDef || (isLegacyCustom ? CUSTOM_ACTION_TOOL : toolDef);
          if (!effectiveToolDef) return;

          // Prevention tools with formFields open a parameter modal;
          // response tools and tools without formFields add a marker directly.
          const hasForm = effectiveToolDef.formFields !== undefined;
          const geoData = {
            waterwaysGeoJSON: waterwaysDataRef.current,
            buildingsGeoJSON: buildingsDataRef.current,
            roadsGeoJSON: roadsDataRef.current,
            waterBodiesGeoJSON: waterBodiesDataRef.current,
          };

          const result = resolvePlacement(ev.lngLat, effectiveToolDef, geoData);
          if (!result.accepted) {
            setToolError(result.reason);
            setTimeout(function () { setToolError(null); }, 3500);
            if (effectiveToolDef.targetType === 'embankment') setPendingAction(null);
            return;
          }

          // Custom action: carry user's text into the marker
          if (isLegacyCustom) {
            result.payload.customLabel = pca.text;
          } else if (customActionDef && pca) {
            result.payload.customLabel = pca.text || customActionDef.label;
          }

          // If this tool has form fields, open the parameter modal
          if (hasForm && planTypeRef.current === 'prevention' && effectiveToolDef.formFields.length > 0) {
            setPendingAction(Object.assign({ toolKey: effectiveToolDef.key }, result.payload));
            return;
          }

          // For removeEncroachment (empty formFields), confirm via modal
          if (hasForm && planTypeRef.current === 'prevention' && effectiveToolDef.formFields.length === 0) {
            setPendingAction(Object.assign({ toolKey: effectiveToolDef.key }, result.payload));
            return;
          }

          // Response tools or tools with no form: add marker directly
          var responseMarker = buildMarker(effectiveToolDef, result.payload, null, planTypeRef.current);
          setMarkers(function (prev) {
            return prev.concat([responseMarker]);
          });
          setUndoStack(function (prev) { return prev.concat([{ type: 'marker', uid: responseMarker._uid }]); });
          playInterventionAnimation(mapRef.current, effectiveToolDef.key, result.payload.lng, result.payload.lat);
          return;
        }

        // No tool selected. On the Response tab, if a start point is already
        // set, treat any plain click as "check the route to here" — this
        // replaces the old separate "Route to any point" toggle. Matches
        // how a real operator thinks: team location is set, just tap where
        // you need to check next.
        if (planTypeRef.current === 'response' && startPointRef.current) {
          runRoute(ev.lngLat.lat, ev.lngLat.lng, 'Selected location');
        }
      });

      // eslint-disable-next-line react-hooks/set-state-in-effect -- fires from the map's async 'load' event callback, not synchronously during the effect body
      setStatus('ready');
    });
  }, [scenario]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource || !scenario) return;
    const src = map.getSource('flooded-roads');
    if (!src) return;

    const features = scenario.flooded_roads.map(function (coords, i) {
      return {
        type: 'Feature',
        properties: { roadIndex: i, closed: closedRoads.some(function (r) { return r.roadIndex === i; }) },
        geometry: { type: 'LineString', coordinates: coords },
      };
    });
    src.setData({ type: 'FeatureCollection', features: features });
  }, [closedRoads, scenario]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('plan-markers');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: markers.map(function (m) {
        return {
          type: 'Feature',
          properties: { color: m.color, label: m.label, emoji: m.emoji, markerType: m.type, planType: m.planType },
          geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        };
      }),
    });
  }, [markers]);

  // Persistent emoji markers — one maplibregl.Marker per plan marker,
  // showing the recognizable intervention icon (🌳, 🧱, 🌊, etc.)
  var persistentMarkersRef = useRef({});
  useEffect(() => {
    var map = mapRef.current;
    if (!map) return;
    var current = persistentMarkersRef.current;
    var activeUids = {};

    markers.forEach(function (m) {
      activeUids[m._uid] = true;
      if (!current[m._uid]) {
        var el = document.createElement('div');
        el.style.fontSize = '20px';
        el.style.lineHeight = '1';
        el.style.textAlign = 'center';
        el.style.pointerEvents = 'none';
        el.style.textShadow = '0 1px 4px rgba(0,0,0,0.5)';
        el.textContent = m.emoji;

        current[m._uid] = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([m.lon, m.lat])
          .addTo(map);
      }
    });

    Object.keys(current).forEach(function (uid) {
      if (!activeUids[uid]) {
        current[uid].remove();
        delete current[uid];
      }
    });
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('start-point');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: startPoint
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [startPoint.lon, startPoint.lat] } }]
        : [],
    });
  }, [startPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('unreachable-hospitals');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: unreachableHospitals.map(function (h) {
        return { type: 'Feature', properties: { name: h.name }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } };
      }),
    });
  }, [unreachableHospitals]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('destination-marker');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: destinationPoint
        ? [{
            type: 'Feature',
            properties: { reachable: destinationPoint.reachable },
            geometry: { type: 'Point', coordinates: [destinationPoint.lon, destinationPoint.lat] },
          }]
        : [],
    });
  }, [destinationPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('embankment-lines');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: embankments.map(function (e) {
        return {
          type: 'Feature',
          properties: { lengthM: e.lengthM, heightM: e.heightM, material: e.material },
          geometry: { type: 'LineString', coordinates: e.lineCoords },
        };
      }),
    });
  }, [embankments]);

  var embankmentAnchorMarkersRef = useRef({});
  useEffect(function () {
    var map = mapRef.current;
    if (!map) return;
    var current = embankmentAnchorMarkersRef.current;
    var activeUids = {};

    embankments.forEach(function (e) {
      activeUids[e._uid] = true;
      if (!current[e._uid]) {
        var el = document.createElement('div');
        el.style.fontSize = '20px';
        el.style.lineHeight = '1';
        el.style.textAlign = 'center';
        el.style.pointerEvents = 'none';
        el.style.textShadow = '0 1px 4px rgba(0,0,0,0.5)';
        el.textContent = '🧱';

        current[e._uid] = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([e.anchorLng, e.anchorLat])
          .addTo(map);
      }
    });

    Object.keys(current).forEach(function (uid) {
      if (!activeUids[uid]) {
        current[uid].remove();
        delete current[uid];
      }
    });
  }, [embankments]);

  function submitPendingAction() {
    if (!pendingAction) return;

    const toolKey = pendingAction.toolKey;
    const toolDef = PREVENTION_TOOLS.find(function (t) { return t.key === toolKey; }) || CUSTOM_ACTIONS.find(function (a) { return a.key === toolKey; });
    const forms = actionForms[toolKey] || {};

    // Validate number ranges for all fields
    if (toolDef && toolDef.formFields) {
      for (var i = 0; i < toolDef.formFields.length; i++) {
        var f = toolDef.formFields[i];
        if (f.type !== 'number') continue;
        var val = Number(forms[f.key]);
        if (!val || val <= 0) {
          setToolError('Enter a positive ' + f.label.toLowerCase() + ' before continuing.');
          setTimeout(function () { setToolError(null); }, 3500);
          return;
        }
        if (f.min !== undefined && val < f.min) {
          setToolError(f.label + ' must be at least ' + f.min + (f.unit ? ' ' + f.unit : '') + '.');
          setTimeout(function () { setToolError(null); }, 3500);
          return;
        }
        if (f.max !== undefined && val > f.max) {
          setToolError(f.label + ' must be at most ' + f.max + (f.unit ? ' ' + f.unit : '') + '.');
          setTimeout(function () { setToolError(null); }, 3500);
          return;
        }
      }
    }

    // Embankment: special submit with geometry build + backend call
    if (toolKey === 'embankment') {
      const lengthM = Number(forms.length);
      const heightM = Number(forms.height);

      const lineResult = buildEmbankmentLine(pendingAction.lng, pendingAction.lat, lengthM, waterwaysDataRef.current);
      if (!lineResult) {
        setToolError('Could not determine the nullah\'s direction at this point — try a slightly different location.');
        setTimeout(function () { setToolError(null); }, 3500);
        return;
      }

      const check = validateEmbankmentLine(lineResult.lineCoords, waterwaysDataRef.current, buildingsDataRef.current, roadsDataRef.current);
      if (!check.accepted) {
        setToolError(check.reason);
        setTimeout(function () { setToolError(null); }, 6000);
        return;
      }

      const waterLevelM = scenario.water_level_m;
      fetch(API_URL + '/embankment-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_coords: lineResult.lineCoords,
          height_m: heightM,
          water_level_m: waterLevelM,
        }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var embUid = nextUid();
          var embRecord = {
            _uid: embUid,
            planType: 'prevention',
            lengthM: lengthM,
            heightM: heightM,
            material: forms.material,
            lineCoords: lineResult.lineCoords,
            anchorLng: pendingAction.lng,
            anchorLat: pendingAction.lat,
            waterwayDistanceM: pendingAction.waterwayDistanceM,
            before: data.before,
            after: data.after,
            difference: data.difference,
          };
          setEmbankments(function (prev) {
            return prev.concat([embRecord]);
          });
          setPendingAction(null);
          setUndoStack(function (prev) { return prev.concat([{ type: 'embankment', uid: embUid }]); });
          playInterventionAnimation(mapRef.current, 'embankment', pendingAction.lng, pendingAction.lat);
        })
        .catch(function (err) {
          console.error('Embankment comparison failed:', err);
          setToolError('Failed to calculate flood impact — check backend is running.');
          setTimeout(function () { setToolError(null); }, 4000);
        });
      return;
    }

    // Widen channel: cross-field check — newWidth/2 vs nearest building
    if (toolKey === 'widenChannel') {
      var newWidth = Number(forms.newWidth);
      if (newWidth && buildingsDataRef.current) {
        var halfWidth = newWidth / 2;
        var clickPt = turf.point([pendingAction.lng, pendingAction.lat]);
        var bFeatures = buildingsDataRef.current.features || [];
        for (var b = 0; b < bFeatures.length; b++) {
          var bg = bFeatures[b].geometry && bFeatures[b].geometry.type;
          var dist = bg === 'Point'
            ? turf.distance(clickPt, bFeatures[b], { units: 'meters' })
            : (bg === 'Polygon' || bg === 'MultiPolygon')
              ? turf.pointToLineDistance(clickPt, bFeatures[b], { units: 'meters' })
              : Infinity;
          if (dist < halfWidth) {
            setToolError('Widening to ' + newWidth + 'm needs ' + Math.round(halfWidth) + 'm clear on each side, but a building is ' + Math.round(dist) + 'm away.');
            setTimeout(function () { setToolError(null); }, 5000);
            return;
          }
        }
      }
    }

    // Retention pond: footprint check — does the pond radius overlap anything?
    if (toolKey === 'retentionPond') {
      var pondArea = Number(forms.area);
      if (pondArea && buildingsDataRef.current) {
        var pondRadius = Math.sqrt(pondArea / Math.PI);
        var pondPt = turf.point([pendingAction.lng, pendingAction.lat]);
        var bFeatures = buildingsDataRef.current.features || [];
        for (var b = 0; b < bFeatures.length; b++) {
          var bg = bFeatures[b].geometry && bFeatures[b].geometry.type;
          var dist = bg === 'Point'
            ? turf.distance(pondPt, bFeatures[b], { units: 'meters' })
            : (bg === 'Polygon' || bg === 'MultiPolygon')
              ? turf.pointToLineDistance(pondPt, bFeatures[b], { units: 'meters' })
              : Infinity;
          if (dist < pondRadius) {
            setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap a building ' + Math.round(dist) + 'm away.');
            setTimeout(function () { setToolError(null); }, 5000);
            return;
          }
        }
        if (roadsDataRef.current && roadsDataRef.current.features) {
          var nearestRoad = turf.nearestPointOnLine(roadsDataRef.current, pondPt, { units: 'meters' });
          if (nearestRoad.properties.dist < pondRadius) {
            setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap a road ' + Math.round(nearestRoad.properties.dist) + 'm away.');
            setTimeout(function () { setToolError(null); }, 5000);
            return;
          }
        }
        if (waterBodiesDataRef.current && waterBodiesDataRef.current.features) {
          for (var w = 0; w < waterBodiesDataRef.current.features.length; w++) {
            var wFeature = waterBodiesDataRef.current.features[w];
            var wDist = turf.pointToLineDistance(pondPt, wFeature, { units: 'meters' });
            if (wDist < pondRadius) {
              setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap an existing water body ' + Math.round(wDist) + 'm away.');
              setTimeout(function () { setToolError(null); }, 5000);
              return;
            }
          }
        }
      }
    }

    // All other tools: add marker with params
    const params = {};
    if (toolDef && toolDef.formFields) {
      toolDef.formFields.forEach(function (f) { params[f.key] = forms[f.key]; });
    }

    const effectiveDef = toolDef || CUSTOM_ACTION_TOOL;
    var prevMarker = buildMarker(effectiveDef, pendingAction, params, 'prevention');
    setMarkers(function (prev) {
      return prev.concat([prevMarker]);
    });
    setUndoStack(function (prev) { return prev.concat([{ type: 'marker', uid: prevMarker._uid }]); });
    playInterventionAnimation(mapRef.current, effectiveDef.key, pendingAction.lng, pendingAction.lat);
    setPendingAction(null);
  }

  function cancelPendingAction() {
    setPendingAction(null);
  }

  function analyzeNoteDraft() {
    const text = noteDraft.trim();
    if (!text) return;
    const match = matchCustomAction(text, scenario && scenario.cause_type);
    if (match.toolKey) {
      // Matched — set state to show suggestion card (prevention or custom)
      setNoteMatch(match);
    } else {
      // No match — show "not supported" card, do NOT arm map
      setNoteMatch({ toolKey: null, error: 'unsupported', text: text });
    }
  }

  function useMatchedAction(matchResult) {
    if (!matchResult || !matchResult.toolKey) return;
    const toolDef = PREVENTION_TOOLS.find(function (t) { return t.key === matchResult.toolKey; });
    if (!toolDef) return;
    setActiveTool(matchResult.toolKey);
    setNoteDraft('');
    setNoteMatch(null);
  }

  function armCustomAction(matchResult) {
    if (!matchResult || !matchResult.toolKey) return;
    var actionDef = CUSTOM_ACTIONS.find(function (a) { return a.key === matchResult.toolKey; });
    if (!actionDef) return;
    // Pre-fill form with extracted params
    var forms = {};
    actionDef.formFields.forEach(function (f) { forms[f.key] = f.default; });
    if (matchResult.extractedParams) {
      actionDef.formFields.forEach(function (f) {
        var extracted = matchResult.extractedParams[f.key];
        if (extracted === undefined) extracted = matchResult.extractedParams.value;
        if (extracted !== undefined) {
          if (f.min !== undefined && extracted < f.min) extracted = f.min;
          if (f.max !== undefined && extracted > f.max) extracted = f.max;
          forms[f.key] = extracted;
        }
      });
    }
    setActionForms(function (prev) {
      var next = {};
      Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
      next[actionDef.key] = forms;
      return next;
    });
    setPendingCustomAction({ text: noteDraft.trim(), toolKey: actionDef.key });
    setActiveTool(actionDef.key);
    setNoteDraft('');
    setNoteMatch(null);
  }

  function forceCustomAction() {
    const text = (noteMatch && noteMatch.text) || noteDraft.trim();
    if (!text) return;
    setPendingCustomAction({ text: text });
    setActiveTool('customAction');
    setNoteDraft('');
    setNoteMatch(null);
  }

  function addNote() {
    const text = noteDraft.trim();
    if (!text) return;
    var noteUid = nextUid();
    setCustomNotes(function (prev) { return prev.concat([{ _uid: noteUid, planType: planType, text: text }]); });
    setUndoStack(function (prev) { return prev.concat([{ type: 'customNote', uid: noteUid }]); });
    setNoteDraft('');
  }

  function undoLast() {
    setUndoStack(function (prev) {
      if (prev.length === 0) return prev;
      var last = prev[prev.length - 1];
      var targetUid = last.uid;
      switch (last.type) {
        case 'marker':
          setMarkers(function (p) { return p.filter(function (m) { return m._uid !== targetUid; }); });
          break;
        case 'embankment':
          setEmbankments(function (p) { return p.filter(function (e) { return e._uid !== targetUid; }); });
          break;
        case 'closedRoad':
          setClosedRoads(function (p) { return p.filter(function (r) { return r._uid !== targetUid; }); });
          break;
        case 'customNote':
          setCustomNotes(function (p) { return p.filter(function (n) { return n._uid !== targetUid; }); });
          break;
      }
      return prev.slice(0, -1);
    });
  }

  function clearAll() {
    setMarkers([]);
    setEmbankments([]);
    setClosedRoads([]);
    setCustomNotes([]);
    setUndoStack([]);
  }

  if (!scenario) {
    return (
      <div style={{ padding: 40, fontFamily: 'system-ui, sans-serif' }}>
        <h2>{status}</h2>
        <button
          onClick={function () { router.push('/map'); }}
          style={{
            marginTop: 16,
            padding: '10px 20px',
            borderRadius: 10,
            border: 'none',
            background: '#2DD4BF',
            color: '#06231F',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ← Back to map
        </button>
      </div>
    );
  }

  const activeToolDef = TOOLS.find(function (t) { return t.key === activeTool; }) || CUSTOM_ACTIONS.find(function (a) { return a.key === activeTool; });
  const currentMarkers = markers.filter(function (m) { return m.planType === planType; });
  const currentEmbankments = embankments.filter(function (e) { return e.planType === planType; });
  const currentNotes = customNotes.filter(function (n) { return n.planType === planType; });

  const hospitalCount = scenario.affected_facilities.filter(function (f) {
    return ['hospital', 'clinic', 'doctors'].indexOf(f.amenity) !== -1;
  }).length;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f172a' }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 999,
          background: 'rgba(15,23,42,0.96)',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <button
          onClick={function () { router.push('/map'); }}
          style={{
            background: 'transparent',
            border: '1px solid #475569',
            color: '#e2e8f0',
            borderRadius: 8,
            padding: '6px 12px',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          ← Map
        </button>

        <div style={{ display: 'flex', gap: 4, background: '#1e293b', padding: 4, borderRadius: 10 }}>
          <button
            onClick={function () { setPlanType('response'); setActiveTool(null); }}
            style={{
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              background: planType === 'response' ? '#dc2626' : 'transparent',
              color: planType === 'response' ? 'white' : '#94a3b8',
              fontWeight: 700,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            🚨 Response Plan
          </button>
          <button
            onClick={function () { setPlanType('prevention'); setActiveTool(null); }}
            style={{
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              background: planType === 'prevention' ? '#0d9488' : 'transparent',
              color: planType === 'prevention' ? 'white' : '#94a3b8',
              fontWeight: 700,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            🛡️ Prevention Plan
          </button>
        </div>

        <div style={{ fontSize: 10, color: '#64748b', marginLeft: 12 }}>
          Planning tool — for real emergencies call <b style={{ color: '#e2e8f0' }}>Rescue 1122</b>
        </div>
        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', fontSize: 11.5, color: '#94a3b8' }}>
          <span><b style={{ color: '#f87171' }}>{scenario.affected_building_count}</b> buildings</span>
          <span><b style={{ color: '#f87171' }}>{scenario.flooded_road_count}</b> roads flooded</span>
          <span><b style={{ color: '#f87171' }}>{hospitalCount}</b> hospitals at risk</span>
          <span><b style={{ color: '#38bdf8' }}>{scenario.avg_depth_m}m</b> avg depth</span>
        </div>
      </div>

      {toolError && (
        <div
          style={{
            position: 'absolute',
            top: 66,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: '#dc2626',
            color: 'white',
            padding: '9px 18px',
            borderRadius: 10,
            fontSize: 12.5,
            fontWeight: 700,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontFamily: 'system-ui, sans-serif',
            maxWidth: 420,
            textAlign: 'center',
          }}
        >
          ⚠️ {toolError}
        </div>
      )}

      {pendingAction && (function () {
        const allTools = PREVENTION_TOOLS.concat(CUSTOM_ACTIONS).concat([CUSTOM_ACTION_TOOL]);
        const toolDef = allTools.find(function (t) { return t.key === pendingAction.toolKey; });
        if (!toolDef) return null;
        const forms = actionForms[pendingAction.toolKey] || {};
        const fields = toolDef.formFields || [];

        function updateField(key, value) {
          setActionForms(function (prev) {
            const toolForms = Object.assign({}, prev[pendingAction.toolKey] || {});
            toolForms[key] = value;
            return Object.assign({}, prev, { [pendingAction.toolKey]: toolForms });
          });
        }

        // Context line for the modal header
        var contextLine = '';
        if (pendingAction.waterwayDistanceM !== undefined) {
          contextLine = Math.round(pendingAction.waterwayDistanceM) + 'm from the nullah';
        }
        if (pendingAction.targetSegmentName) {
          contextLine += (contextLine ? ' · ' : '') + 'on ' + pendingAction.targetSegmentName;
        }
        if (pendingAction.clickedBuilding) {
          var props = pendingAction.clickedBuilding.properties || {};
          var bName = props.name || props.amenity || 'building';
          contextLine = 'Selected: ' + bName;
        }

        const submitLabel = toolDef.submitLabel || 'Add to plan';
        const inputStyle = { width: '100%', padding: 6, marginTop: 3, marginBottom: 8, borderRadius: 8, border: '1px solid #cbd5e1', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, color: '#0f172a', background: '#ffffff' };

        return (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1000,
              background: 'white',
              borderRadius: 14,
              boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
              padding: 14,
              width: 300,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
              {toolDef.emoji} {toolDef.label}
            </div>
            {contextLine && (
              <div style={{ fontSize: 10.5, color: '#64748b', marginBottom: 10 }}>
                {contextLine}
              </div>
            )}

            {fields.length === 0 && (
              <div style={{ fontSize: 11, color: '#475569', marginBottom: 10 }}>
                {pendingAction.clickedBuilding
                  ? 'Confirm removal of this structure from the flood channel.'
                  : 'Confirm this action at the selected location.'}
              </div>
            )}

            {fields.map(function (field) {
              if (field.type === 'select') {
                return (
                  <div key={field.key}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>{field.label}</label>
                    <select
                      value={forms[field.key] || field.default}
                      onChange={function (e) { updateField(field.key, e.target.value); }}
                      style={inputStyle}
                    >
                      {field.options.map(function (opt) {
                        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
                      })}
                    </select>
                  </div>
                );
              }
              return (
                <div key={field.key}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
                    {field.label}{field.unit ? ' (' + field.unit + ')' : ''}
                  </label>
                  <input
                    type="number"
                    value={forms[field.key] !== undefined ? forms[field.key] : field.default}
                    onChange={function (e) { updateField(field.key, e.target.value); }}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    style={inputStyle}
                  />
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 6, marginTop: fields.length > 0 ? 4 : 0 }}>
              <button
                onClick={cancelPendingAction}
                style={{ flex: 1, padding: 8, borderRadius: 9, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={submitPendingAction}
                style={{ flex: 2, padding: 8, borderRadius: 9, border: 'none', background: toolDef.color, color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
              >
                {submitLabel}
              </button>
            </div>
          </div>
        );
      })()}

      <div
        style={{
          position: 'absolute',
          top: 60,
          left: 16,
          zIndex: 999,
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          padding: 14,
          width: 250,
          maxHeight: 'calc(100vh - 90px)',
          overflowY: 'auto',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 3 }}>
          {planType === 'response' ? 'Response actions' : 'Prevention measures'}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
          {planType === 'response'
            ? 'Actions for the flood happening now'
            : (function () {
                var meta = SCENARIO_META[scenario && scenario.cause_type];
                if (!meta) return 'Fixes applied before a flood — see the effect below';
                return meta.emoji + ' ' + meta.label + ' — ' + meta.description;
              })()}
        </div>

        {TOOLS.map(function (tool) {
          const active = activeTool === tool.key;
          return (
            <button
              key={tool.key}
              onClick={function () { setActiveTool(active ? null : tool.key); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                marginBottom: 5,
                padding: '8px 10px',
                borderRadius: 11,
                border: active ? '2px solid ' + tool.color : '2px solid #e2e8f0',
                background: active ? tool.color + '15' : '#f8fafc',
                color: active ? tool.color : '#475569',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 16 }}>{tool.emoji}</span>
              <span style={{ flex: 1 }}>{tool.label}</span>
            </button>
          );
        })}

        {activeToolDef && (
          <div
            style={{
              marginTop: 8,
              padding: 9,
              borderRadius: 10,
              background: activeToolDef.color + '12',
              color: activeToolDef.color,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {activeToolDef.hint}
            {activeToolDef.effectLabel && (
              <div style={{ marginTop: 4, opacity: 0.85 }}>Effect: {activeToolDef.effectLabel}</div>
            )}
            {activeToolDef.realBasis && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid ' + activeToolDef.color + '30', fontSize: 10, fontWeight: 500, opacity: 0.9 }}>
                📰 {activeToolDef.realBasis}
              </div>
            )}
          </div>
        )}

        {planType === 'response' && (
        <div style={{ marginTop: 14, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
            🚑 Rescue routing
          </div>

          <button
            onClick={function () { setActiveTool(activeTool === 'setStart' ? null : 'setStart'); }}
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: 9,
              border: activeTool === 'setStart' ? '2px solid #2563eb' : '1px solid #e2e8f0',
              background: activeTool === 'setStart' ? '#eff6ff' : '#f8fafc',
              color: activeTool === 'setStart' ? '#2563eb' : '#475569',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            📍 {startPoint ? 'Change start point' : 'Set start point'}
          </button>

          {startPoint && (
            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2, marginBottom: 4 }}>
              Team location set. Click any hospital or any other point on the map to check if it&apos;s reachable.
            </div>
          )}

          {startPoint && checkingAccess && (
            <div style={{ fontSize: 10.5, color: '#2563eb', marginTop: 6, fontWeight: 600 }}>
              🔄 Checking access to all hospitals...
            </div>
          )}

          {startPoint && !checkingAccess && (
            <div
              style={{
                marginTop: 6,
                padding: 8,
                borderRadius: 9,
                fontSize: 11,
                fontWeight: 600,
                background: unreachableHospitals.length > 0 ? '#fef2f2' : '#f0fdf4',
                color: unreachableHospitals.length > 0 ? '#dc2626' : '#16a34a',
              }}
            >
              {unreachableHospitals.length > 0
                ? '❌ ' + unreachableHospitals.length + ' hospital(s) unreachable — marked ✕ on map'
                : '✅ All ' + hospitalCount + ' hospitals reachable'}
            </div>
          )}

          {routeInfo && !routeInfo.loading && !routeInfo.error && (
            <div
              style={{
                marginTop: 8,
                padding: 9,
                borderRadius: 10,
                background: routeInfo.reachable ? (routeInfo.crossesFlood ? '#fefce8' : '#f0fdf4') : '#fef2f2',
                fontSize: 11,
              }}
            >
              <b>{routeInfo.hospitalName}</b>
              <div style={{ marginTop: 3 }}>
                {!routeInfo.crossesFlood && '✅ Direct route is clear (' + (routeInfo.directLengthM / 1000).toFixed(2) + ' km)'}
                {routeInfo.crossesFlood && routeInfo.reachable && '⚠️ Direct route floods — using detour (' + (routeInfo.safeLengthM / 1000).toFixed(2) + ' km)'}
                {!routeInfo.reachable && '❌ No route — that location is cut off by this flood'}
              </div>
            </div>
          )}

          {routeInfo && routeInfo.error && (
            <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: '#fef2f2', color: '#dc2626', fontSize: 11 }}>
              {routeInfo.error}
            </div>
          )}
        </div>
        )}

        <div style={{ marginTop: 14, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
            ✍️ Other action
          </div>
          <textarea
            value={noteDraft}
            onChange={function (e) { setNoteDraft(e.target.value); setNoteMatch(null); }}
            placeholder="Describe any other step your team would take..."
            rows={3}
            style={{
              width: '100%',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 8,
              fontSize: 11.5,
              fontFamily: 'system-ui, sans-serif',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />

          {!noteMatch && (
            <button
              onClick={analyzeNoteDraft}
              style={{
                width: '100%',
                marginTop: 6,
                padding: '7px',
                borderRadius: 9,
                border: 'none',
                background: '#0f172a',
                color: 'white',
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Check this action
            </button>
          )}

          {noteMatch && noteMatch.toolKey && noteMatch.source === 'prevention' && (
            <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#166534', marginBottom: 4 }}>
                Matched existing action
              </div>
              <div style={{ fontSize: 10.5, color: '#475569', marginBottom: 6 }}>
                This is similar to <b>{(function () { var t = PREVENTION_TOOLS.find(function (t) { return t.key === noteMatch.toolKey; }) || CUSTOM_ACTIONS.find(function (a) { return a.key === noteMatch.toolKey; }); return t ? t.label : noteMatch.toolKey; })()}</b>.
                {noteMatch.matchedTerms && noteMatch.matchedTerms.length > 0 && (
                  <span> (matched: {noteMatch.matchedTerms.join(', ')})</span>
                )}
              </div>
              {noteMatch.runnerUp && (
                <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6 }}>
                  Or maybe: <b>{(function () { var t = PREVENTION_TOOLS.find(function (t) { return t.key === noteMatch.runnerUp.toolKey; }) || CUSTOM_ACTIONS.find(function (a) { return a.key === noteMatch.runnerUp.toolKey; }); return t ? t.label : noteMatch.runnerUp.toolKey; })()}</b>
                  <button
                    onClick={function () { noteMatch.runnerUp.source === 'custom' ? armCustomAction(noteMatch.runnerUp) : useMatchedAction(noteMatch.runnerUp); }}
                    style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: 'white', color: '#334155', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Use this instead
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={function () { useMatchedAction(noteMatch); }}
                  style={{ flex: 2, padding: 6, borderRadius: 8, border: 'none', background: '#166534', color: 'white', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >
                  Use {(function () { var t = PREVENTION_TOOLS.find(function (t) { return t.key === noteMatch.toolKey; }); return t ? t.label : noteMatch.toolKey; })()}
                </button>
                <button
                  onClick={forceCustomAction}
                  style={{ flex: 1, padding: 6, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                >
                  No, it&apos;s different
                </button>
              </div>
            </div>
          )}

          {noteMatch && noteMatch.toolKey && noteMatch.source === 'custom' && (function () {
            var actionDef = CUSTOM_ACTIONS.find(function (a) { return a.key === noteMatch.toolKey; });
            if (!actionDef) return null;
            var paramLines = [];
            if (noteMatch.extractedParams) {
              Object.keys(noteMatch.extractedParams).forEach(function (k) {
                paramLines.push(k + ' = ' + noteMatch.extractedParams[k] + 'm');
              });
            }
            var targetLabel = actionDef.targetType === 'road' ? 'Road segment' : actionDef.targetType === 'waterwayBank' ? 'Waterway bank' : actionDef.targetType === 'openLand' ? 'Open land' : actionDef.targetType;
            return (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1e40af', marginBottom: 4 }}>
                  {actionDef.emoji} New intervention: {actionDef.label}
                </div>
                <div style={{ fontSize: 10.5, color: '#475569', marginBottom: 2 }}>
                  <b>Target:</b> {targetLabel}
                </div>
                {paramLines.length > 0 && (
                  <div style={{ fontSize: 10.5, color: '#475569', marginBottom: 2 }}>
                    <b>Parameters:</b> {paramLines.join(', ')} (from your input)
                  </div>
                )}
                {noteMatch.matchedTerms && noteMatch.matchedTerms.length > 0 && (
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>
                    matched: {noteMatch.matchedTerms.join(', ')}
                  </div>
                )}
                {noteMatch.runnerUp && (
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6 }}>
                    Or maybe: <b>{(function () { var t = PREVENTION_TOOLS.find(function (t) { return t.key === noteMatch.runnerUp.toolKey; }) || CUSTOM_ACTIONS.find(function (a) { return a.key === noteMatch.runnerUp.toolKey; }); return t ? t.label : noteMatch.runnerUp.toolKey; })()}</b>
                    <button
                      onClick={function () { noteMatch.runnerUp.source === 'custom' ? armCustomAction(noteMatch.runnerUp) : useMatchedAction(noteMatch.runnerUp); }}
                      style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: 'white', color: '#334155', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                    >
                      Use this instead
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={function () { armCustomAction(noteMatch); }}
                    style={{ flex: 2, padding: 6, borderRadius: 8, border: 'none', background: '#1e40af', color: 'white', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Apply this action
                  </button>
                  <button
                    onClick={function () { setNoteMatch(null); }}
                    style={{ flex: 1, padding: 6, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })()}

          {noteMatch && !noteMatch.toolKey && noteMatch.error === 'unsupported' && (
            <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: '#fefce8', border: '1px solid #fde68a' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>
                ⚠️ Action not supported
              </div>
              <div style={{ fontSize: 10.5, color: '#475569', marginBottom: 4 }}>
                Mohafiz could not determine a safe way to simulate this intervention.
              </div>
              <div style={{ fontSize: 10, color: '#64748b' }}>
                Try: {(function () {
                  var suggestions = {
                    rainfall:         '\u201cClear blocked drains\u201d, \u201cBuild a retention pond\u201d, \u201cRaise the road by 1m\u201d',
                    river_overflow:   '\u201cBuild an embankment\u201d, \u201cRemove encroachment\u201d, \u201cInstall warning gauge\u201d',
                    drainage_failure: '\u201cDesilt the drain\u201d, \u201cClear blocked drain\u201d, \u201cAdd a drainage channel\u201d',
                    dam_release:      '\u201cRaise embankments\u201d, \u201cCreate flood storage\u201d, \u201cEarly warning gauge\u201d',
                  };
                  var ct = scenario && scenario.cause_type;
                  return suggestions[ct] || '\u201cRaise the road\u201d, \u201cBuild a drainage channel\u201d, \u201cCreate a flood barrier\u201d';
                })()}, or describe what you want to build, remove, raise, widen, or improve.
              </div>
              <button
                onClick={function () { setNoteMatch(null); }}
                style={{ marginTop: 6, padding: '3px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white', color: '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button
            onClick={undoLast}
            style={{
              flex: 1,
              padding: '7px',
              borderRadius: 9,
              border: '1px solid #e2e8f0',
              background: '#f8fafc',
              color: '#475569',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Undo
          </button>
          <button
            onClick={clearAll}
            style={{
              flex: 1,
              padding: '7px',
              borderRadius: 9,
              border: '1px solid #fecaca',
              background: '#fef2f2',
              color: '#dc2626',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          zIndex: 999,
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          padding: 14,
          width: 270,
          maxHeight: '55vh',
          overflowY: 'auto',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
          {planType === 'response' ? '🚨 Response plan' : '🛡️ Prevention plan'}
        </div>

        {currentMarkers.length === 0 && currentEmbankments.length === 0 && currentNotes.length === 0 && closedRoads.length === 0 && (
          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
            Nothing added yet. Pick an action, then click the map.
          </div>
        )}

        {planType === 'response' && closedRoads.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
            🚧 <b>{closedRoads.length}</b> road{closedRoads.length > 1 ? 's' : ''} closed
          </div>
        )}

        {currentEmbankments.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
            🧱 <b>{currentEmbankments.length}</b> × Build / raise embankment
            {currentEmbankments.map(function (e, i) {
              return (
                <div key={i} style={{ fontSize: 10, marginLeft: 20, marginTop: 4, padding: 6, background: '#f8fafc', borderRadius: 6 }}>
                  <div style={{ color: '#475569', fontWeight: 600 }}>
                    {e.lengthM}m long, {e.heightM}m high, {e.material}
                  </div>
                  {e.difference ? (
                    <div style={{ marginTop: 3 }}>
                      <div style={{ color: '#059669', fontWeight: 700 }}>
                        ✅ {e.difference.roads_saved} road{e.difference.roads_saved !== 1 ? 's' : ''} saved
                      </div>
                      <div style={{ color: '#64748b' }}>
                        {e.difference.area_saved_m2 > 0 ? Math.round(e.difference.area_saved_m2) + ' m² protected' : 'No area change'}
                      </div>
                      <div style={{ color: '#94a3b8', fontSize: 9 }}>
                        {e.before.flooded_percent}% → {e.after.flooded_percent}% flooded
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: '#94a3b8' }}>Calculating impact...</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {TOOLS.filter(function (t) { return t.kind === 'point'; }).map(function (t) {
          const matching = currentMarkers.filter(function (m) { return m.type === t.key && !m.isCustom; });
          if (matching.length === 0) return null;
          const segmentNames = Array.from(new Set(
            matching.map(function (m) { return m.targetSegmentName; }).filter(Boolean)
          ));
          const paramLines = matching
            .map(function (m) { return formatParams(t, m.params); })
            .filter(Boolean);
          return (
            <div key={t.key} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
              {t.emoji} <b>{matching.length}</b> × {t.label}
              {segmentNames.length > 0 && (
                <div style={{ fontSize: 10, color: '#94a3b8', marginLeft: 20 }}>
                  on {segmentNames.join(', ')}
                </div>
              )}
              {paramLines.length > 0 && paramLines.slice(0, 3).map(function (p, i) {
                return (
                  <div key={i} style={{ fontSize: 10, color: '#64748b', marginLeft: 20 }}>
                    {p}
                  </div>
                );
              })}
            </div>
          );
        })}

        {CUSTOM_ACTIONS.map(function (t) {
          const matching = currentMarkers.filter(function (m) { return m.type === t.key; });
          if (matching.length === 0) return null;
          const paramLines = matching
            .map(function (m) { return formatParams(t, m.params); })
            .filter(Boolean);
          return (
            <div key={t.key} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
              {t.emoji} <b>{matching.length}</b> × {t.label}
              {paramLines.length > 0 && paramLines.slice(0, 3).map(function (p, i) {
                return (
                  <div key={i} style={{ fontSize: 10, color: '#64748b', marginLeft: 20 }}>
                    {p}
                  </div>
                );
              })}
            </div>
          );
        })}

        {(function () {
          var customActionKeys = CUSTOM_ACTIONS.map(function (a) { return a.key; });
          const customMarkers = currentMarkers.filter(function (m) { return m.isCustom && customActionKeys.indexOf(m.type) === -1; });
          const allCustom = customMarkers.concat(
            currentNotes.map(function (n) { return { text: n.text, isNote: true }; })
          );
          if (allCustom.length === 0) return null;
          return (
            <div style={{ marginTop: 8, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>
                Custom actions
              </div>
              {allCustom.map(function (item, i) {
                return (
                  <div key={i} style={{ fontSize: 11.5, color: '#334155', marginBottom: 4 }}>
                    ✍️ {item.text || item.label}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}