'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import { deriveImpact, formatFloodPctDelta } from '@/lib/impactFormat';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8002';

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

// Response actions. `phase` tracks the rollout; tools with
// implemented:false are shown but disabled, because a shelter or a
// helipad placed with NO validation is worse than one you cannot place
// yet — it looks checked when nothing checked it.
const RESPONSE_TOOLS = [
  {
    key: 'closeRoad',
    label: 'Close flooded road',
    emoji: '🚧',
    color: '#dc2626',
    kind: 'road',
    phase: 1,
    implemented: true,
    targetType: 'floodedRoad',
    hint: 'Click ON a road that is under water — rejects roads that are dry, and roads whose water is too shallow to actually stop traffic',
    effectLabel: 'Marks the road impassable for this response plan',
    formFields: [
      { key: 'durationHr', label: 'Expected duration', type: 'number', optional: true, min: 1, max: 168, step: 1, unit: 'hr', default: '' },
    ],
    submitLabel: 'Close this road',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      const lines = [
        { label: 'Road', value: pending.roadName || String(pending.roadHighwayType).replace(/_/g, ' ') },
        { label: 'Water on road', value: formatDepth(pending.depthM), tone: 'bad' },
        { label: 'Impassable above', value: formatDepth(rules.IMPASSABLE_ROAD_DEPTH_M) },
      ];
      if (pending.floodedRoadIndex === null || pending.floodedRoadIndex === undefined) {
        lines.push({ label: 'Note', value: 'Not one of the roads the simulation flagged — closed on measured depth', tone: 'warn' });
      }
      return lines;
    },
  },
  {
    key: 'boatLaunch',
    label: 'Boat launch point',
    emoji: '🛟',
    color: '#0ea5e9',
    kind: 'point',
    phase: 1,
    implemented: true,
    targetType: 'boatLaunch',
    hint: 'Click where rescue boats go in — needs floodwater at or beside the point AND a road close enough to get a trailer there',
    effectLabel: 'Deployment point for boat rescue teams',
    formFields: [
      { key: 'boatCount', label: 'Boats available', type: 'number', optional: true, min: 1, max: 50, step: 1, unit: '', default: '' },
    ],
    submitLabel: 'Add launch point',
    computeSummary: function (pending, forms, geoData) {
      const lines = [];
      if (pending.atWaterEdge) {
        lines.push({ label: 'Water', value: Math.round(pending.waterDistanceM) + 'm away, ' + formatDepth(pending.maxDepthNearbyM) + ' deep' });
      } else {
        lines.push({ label: 'Water at point', value: formatDepth(pending.depthM) + ' deep' });
      }
      lines.push({
        label: 'Road access',
        value: (pending.roadName || String(pending.roadHighwayType).replace(/_/g, ' ')) + ', ' + Math.round(pending.roadDistanceM) + 'm',
        tone: 'good',
      });
      return lines;
    },
  },
  {
    key: 'evacuationZone',
    label: 'Priority evacuation zone',
    emoji: '⚠️',
    color: '#7c3aed',
    kind: 'area',
    phase: 1,
    implemented: true,
    targetType: 'evacuationZone',
    hint: 'Click the centre of an area to evacuate first, then set its radius — the zone reports its deepest water, how many buildings it covers, and any hospital inside it',
    effectLabel: 'Marks an area for first-priority evacuation',
    formFields: [
      { key: 'radiusM', label: 'Zone radius', type: 'number', min: 50, max: 2000, step: 25, unit: 'm', default: 300 },
    ],
    submitLabel: 'Add evacuation zone',
    computeSummary: function (pending, forms, geoData) {
      const radius = Number(forms.radiusM);
      if (!radius || radius <= 0) {
        return [{ label: 'Zone', value: 'Enter a radius above 0 to see what is inside', tone: 'warn' }];
      }
      const stats = computeEvacuationZoneStats(pending.lat, pending.lng, radius, geoData.scenario, geoData);
      const lines = [];
      if (stats.critical) {
        lines.push({
          label: 'PRIORITY',
          value: 'CRITICAL — ' + stats.hospitals.length + ' hospital' + (stats.hospitals.length > 1 ? 's' : '') + ' inside: ' + stats.hospitals.join(', '),
          tone: 'critical',
        });
      }
      lines.push({
        label: 'Max water depth',
        value: stats.maxDepthM > 0 ? formatDepth(stats.maxDepthM) : 'no flooding in this zone',
        tone: stats.maxDepthM > 0 ? 'bad' : 'warn',
      });
      lines.push({ label: 'Area flooded', value: stats.floodedPercent + '%' });
      lines.push({ label: 'Buildings inside', value: String(stats.buildingCount) });
      return lines;
    },
  },

  // ---- Phase 2: safe-zone logistics ----
  {
    key: 'reliefCamp',
    label: 'Relief camp / shelter',
    emoji: '🏕️',
    color: '#16a34a',
    kind: 'point',
    phase: 2,
    implemented: true,
    targetType: 'reliefCamp',
    safetyNoun: 'shelter',
    hint: 'Click ground clear of the flood — snaps onto a nearby school or community building if there is one. Clicks in or beside the water are always rejected.',
    effectLabel: 'Shelter site for displaced families',
    formFields: [
      { key: 'capacity', label: 'Capacity', type: 'number', min: 1, max: 20000, step: 10, unit: 'people', default: 200 },
    ],
    submitLabel: 'Add shelter',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      const lines = [];
      if (pending.snappedFacilityName) {
        lines.push({
          label: 'Snapped to',
          value: pending.snappedFacilityName + ' (' + amenityLabel(pending.snappedFacilityAmenity) + ', ' +
            Math.round(pending.snapDistanceM) + 'm from your click)',
          tone: 'good',
        });
      } else if (pending.rejectedSnapReason) {
        lines.push({ label: 'Site', value: 'Open ground — ' + pending.rejectedSnapReason, tone: 'warn' });
      } else {
        lines.push({ label: 'Site', value: 'Open ground — no mapped school or shelter within ' + rules.SHELTER_SNAP_MAX_M + 'm' });
      }
      lines.push(floodClearanceLine(pending.nearestFloodM, rules));
      return lines;
    },
  },
  {
    key: 'medicalPost',
    label: 'Medical / first-aid post',
    emoji: '🚑',
    color: '#e11d48',
    kind: 'point',
    phase: 2,
    implemented: true,
    targetType: 'medicalPost',
    safetyNoun: 'medical post',
    hint: 'Click ground clear of the flood. The popup shows how far the nearest real hospital is, so you can see whether this post fills a gap.',
    effectLabel: 'Field medical post for casualties and first aid',
    formFields: [
      { key: 'postType', label: 'Post type', type: 'select', options: [
        { value: 'first_aid', label: 'First aid' },
        { value: 'triage', label: 'Triage point' },
        { value: 'trauma', label: 'Trauma / stabilisation' },
        { value: 'mobile', label: 'Mobile unit' },
      ], default: 'first_aid' },
      { key: 'capacity', label: 'Capacity', type: 'number', optional: true, min: 1, max: 5000, step: 5, unit: 'patients', default: '' },
    ],
    submitLabel: 'Add medical post',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      const lines = [floodClearanceLine(pending.nearestFloodM, rules)];

      if (pending.nearestHospitalM === null || pending.nearestHospitalM === undefined) {
        lines.push({ label: 'Nearest hospital', value: 'none found in the facilities layer', tone: 'warn' });
      } else {
        const km = pending.nearestHospitalM >= 1000;
        const dist = km
          ? (pending.nearestHospitalM / 1000).toFixed(1) + 'km'
          : Math.round(pending.nearestHospitalM) + 'm';
        lines.push({
          label: 'Nearest hospital',
          value: pending.nearestHospitalName + ', ' + dist + ' away',
          // Close by is not wrong, but it is worth seeing before committing
          // a post that may duplicate a hospital still in service.
          tone: pending.nearestHospitalM < 300 ? 'warn' : 'good',
        });
      }
      return lines;
    },
  },
  {
    key: 'supplyPoint',
    label: 'Food & water distribution',
    emoji: '🍲',
    color: '#ca8a04',
    kind: 'point',
    phase: 2,
    implemented: true,
    targetType: 'supplyPoint',
    safetyNoun: 'distribution point',
    hint: 'Click ground clear of the flood. The popup reports whether a supply truck can actually reach the point.',
    effectLabel: 'Distribution point for food and drinking water',
    formFields: [
      { key: 'supplyCapacity', label: 'Supply capacity', type: 'number', optional: true, min: 1, max: 100000, step: 50, unit: 'people/day', default: '' },
    ],
    submitLabel: 'Add distribution point',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      const lines = [floodClearanceLine(pending.nearestFloodM, rules)];

      if (pending.roadDistanceM === null || pending.roadDistanceM === undefined) {
        lines.push({ label: 'Road access', value: 'road data not loaded — unverified', tone: 'warn' });
      } else if (pending.roadReachable) {
        lines.push({
          label: 'Road access',
          value: (pending.roadName || amenityLabel(pending.roadHighwayType)) + ', ' + Math.round(pending.roadDistanceM) + 'm',
          tone: 'good',
        });
      } else {
        lines.push({
          label: 'Road access',
          value: 'nearest road is ' + Math.round(pending.roadDistanceM) + 'm away — supplies would need carrying the last stretch',
          tone: 'warn',
        });
      }
      return lines;
    },
  },

  // ---- Phase 3: specialised terrain actions ----
  {
    key: 'dewatering',
    label: 'Dewatering pump',
    emoji: '💧',
    color: '#0891b2',
    kind: 'point',
    phase: 3,
    implemented: true,
    targetType: 'dewatering',
    hint: 'Click standing water — the pump snaps to the deepest point within 60m, so it lands where water actually pools rather than on the shallow rim.',
    effectLabel: 'Pump site for draining standing water',
    formFields: [
      { key: 'capacityLps', label: 'Pump capacity', type: 'number', min: 1, max: 5000, step: 5, unit: 'L/s', default: 50 },
    ],
    submitLabel: 'Add pump',
    computeSummary: function (pending, forms, geoData) {
      const lines = [];
      if (pending.movedToDeepestM > 5) {
        lines.push({
          label: 'Moved to deepest',
          value: Math.round(pending.movedToDeepestM) + 'm from your click, ' +
            formatDepth(pending.clickDepthM) + ' → ' + formatDepth(pending.depthM),
          tone: 'good',
        });
      } else {
        lines.push({
          label: 'Position',
          value: 'already the deepest point within ' + pending.searchRadiusM + 'm',
          tone: 'good',
        });
      }
      lines.push({ label: 'Water depth here', value: formatDepth(pending.depthM), tone: 'bad' });
      return lines;
    },
  },
  {
    key: 'helipad',
    label: 'Helicopter landing zone',
    emoji: '🚁',
    color: '#475569',
    kind: 'point',
    phase: 3,
    implemented: true,
    targetType: 'helipad',
    hint: 'Click dry open ground (parks, fields). Rejects buildings, anything in the flood extent, and any space too small to hold a 40m clear radius.',
    effectLabel: 'Touchdown site for helicopter operations',
    formFields: [],
    submitLabel: 'Add landing zone',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      return [
        { label: 'Open ground', value: pending.spaceName, tone: 'good' },
        { label: 'Clear radius', value: pending.clearRadiusM + 'm confirmed clear of buildings', tone: 'good' },
        {
          label: 'Flood clearance',
          value: isFinite(pending.nearestFloodM)
            ? Math.round(pending.nearestFloodM) + 'm from the nearest floodwater'
            : 'no floodwater within the clear radius',
          tone: 'good',
        },
        { label: 'Sized for', value: 'medium lift (Mi-17 class, ~21m rotor)' },
      ];
    },
  },
  {
    key: 'diversion',
    label: 'Traffic diversion point',
    emoji: '↩️',
    color: '#8b5cf6',
    kind: 'point',
    phase: 3,
    implemented: true,
    targetType: 'diversion',
    hint: 'Click where traffic should be turned around. Requires a road closure already in this plan within 250m — close the flooded road first.',
    effectLabel: 'Point where traffic is turned away from a closure',
    formFields: [],
    submitLabel: 'Add diversion point',
    computeSummary: function (pending, forms, geoData) {
      const lines = [
        {
          label: 'Diverting from',
          value: pending.divertingFrom + ', ' + Math.round(pending.closureDistanceM) + 'm away',
          tone: 'good',
        },
      ];
      lines.push(pending.onRoad
        ? { label: 'On road', value: pending.roadName || amenityLabel(pending.roadHighwayType) }
        : { label: 'On road', value: 'no road within ' + getResponseRules(geoData.scenario).ROAD_SNAP_MAX_M + 'm of the click', tone: 'warn' });
      if (pending.selfFlooded) {
        lines.push({
          label: 'Warning',
          value: 'this point is itself under ' + formatDepth(pending.selfFloodDepthM) + ' of water',
          tone: 'warn',
        });
      }

      // Verdict from the directed road network — see the /diversion-check
      // effect. Reported, never blocking: OSM oneway data is not perfect
      // and the planner may know the junction better than the map does.
      const dc = geoData.diversionCheck;
      if (!dc) {
        // nothing to add yet
      } else if (dc.loading) {
        lines.push({ label: 'Road-network check', value: 'checking which side of the closure this is on…' });
      } else if (dc.error) {
        lines.push({ label: 'Road-network check', value: 'could not run (' + dc.error + ') — position not verified', tone: 'warn' });
      } else if (!dc.checked) {
        lines.push({ label: 'Road-network check', value: dc.reason || 'not verifiable for this closure', tone: 'warn' });
      } else {
        lines.push(dc.upstream
          ? { label: 'Position', value: 'upstream — traffic here still reaches the closure', tone: 'good' }
          : { label: 'Position', value: 'NOT upstream — traffic passing here never meets that closure, so turning them here achieves nothing', tone: 'critical' });
        lines.push(dc.alternative_exists
          ? { label: 'Way round', value: 'a route past the closure exists from this point', tone: 'good' }
          : { label: 'Way round', value: 'no route past the closure from here — drivers would need turning back further upstream', tone: 'critical' });
      }
      return lines;
    },
  },
  {
    key: 'warningPoint',
    label: 'Warning announcement point',
    emoji: '📢',
    color: '#f59e0b',
    kind: 'area',
    phase: 3,
    implemented: true,
    targetType: 'warningPoint',
    hint: 'Click a mosque or public point for loudspeaker warnings — snaps onto a real one if it is within 80m. Set the coverage radius to see what it reaches.',
    effectLabel: 'Loudspeaker / siren coverage for residents',
    formFields: [
      { key: 'coverageRadiusM', label: 'Coverage radius', type: 'number', min: 50, max: 3000, step: 25, unit: 'm', default: 400 },
    ],
    submitLabel: 'Add warning point',
    computeSummary: function (pending, forms, geoData) {
      const rules = getResponseRules(geoData.scenario);
      const lines = [];

      if (pending.snappedFacilityName) {
        lines.push({
          label: 'Snapped to',
          value: pending.snappedFacilityName + ' (' + amenityLabel(pending.snappedFacilityAmenity) + ', ' +
            Math.round(pending.snapDistanceM) + 'm from your click)',
          tone: 'good',
        });
      } else {
        lines.push({ label: 'Site', value: 'open point — no mosque or public building within ' + rules.WARNING_SNAP_MAX_M + 'm' });
      }

      const radius = Number(forms.coverageRadiusM);
      if (!radius || radius <= 0) {
        lines.push({ label: 'Coverage', value: 'enter a radius above 0 to see what it reaches', tone: 'warn' });
      } else {
        const cov = computeWarningCoverage(pending.lat, pending.lng, radius, geoData);
        lines.push({ label: 'Buildings covered', value: String(cov.buildingCount) });
        lines.push({ label: 'People (rough estimate)', value: '≈ ' + cov.estimatedPeople + ' at 6.5 per building' });
      }

      if (pending.selfFlooded) {
        lines.push({
          label: 'Warning',
          value: 'this point is itself under ' + formatDepth(pending.selfFloodDepthM) + ' of water',
          tone: 'warn',
        });
      }
      return lines;
    },
  },
];

const PREVENTION_TOOLS = [
  {
    key: 'desilt',
    label: 'Desilt Nullah',
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
    label: 'Unblock Drain',
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
    label: 'Raise Protective Bank',
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
    label: 'Widen Waterway',
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
      { key: 'newWidth', label: 'New channel width', type: 'number', min: 3, max: 40, step: 0.5, unit: 'm', default: 15 },
      { key: 'length', label: 'Section length', type: 'number', min: 10, max: 500, step: 10, unit: 'm', default: 100 },
    ],
  },
  {
    key: 'removeEncroachment',
    label: 'Clear Blocking Structure',
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
    label: 'Water Storage Pond',
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
      { key: 'area', label: 'Surface area', type: 'number', min: 500, max: 200000, step: 500, unit: 'm²', default: 10000 },
      { key: 'depth', label: 'Depth', type: 'number', min: 0.5, max: 8, step: 0.5, unit: 'm', default: 3 },
    ],
  },
  {
    key: 'warningGauge',
    label: 'Flood Alert Sensor',
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
    label: 'Tree Buffer Zone',
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
// Minimum distance from a point to any feature geometry.
// pointToLineDistance only accepts LineString/MultiLineString, so we
// convert polygon boundaries to lines first.
// ---------------------------------------------------------------------
function pointToFeatureDistance(pt, feature) {
  var geomType = feature.geometry && feature.geometry.type;
  if (geomType === 'Point') {
    return turf.distance(pt, feature, { units: 'meters' });
  }
  if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
    var lines = turf.polygonToLine(feature);
    var lineArr = lines.type === 'FeatureCollection' ? lines.features : [lines];
    var minDist = Infinity;
    for (var i = 0; i < lineArr.length; i++) {
      var lineGeom = lineArr[i].geometry && lineArr[i].geometry.type;
      if (lineGeom === 'MultiLineString') {
        var coords = lineArr[i].geometry.coordinates;
        for (var j = 0; j < coords.length; j++) {
          var d = turf.pointToLineDistance(pt, turf.lineString(coords[j]), { units: 'meters' });
          if (d < minDist) minDist = d;
        }
      } else if (lineGeom === 'LineString') {
        var d2 = turf.pointToLineDistance(pt, lineArr[i], { units: 'meters' });
        if (d2 < minDist) minDist = d2;
      }
    }
    return minDist;
  }
  if (geomType === 'LineString') {
    return turf.pointToLineDistance(pt, feature, { units: 'meters' });
  }
  if (geomType === 'MultiLineString') {
    var mlCoords = feature.geometry.coordinates;
    var mlMin = Infinity;
    for (var k = 0; k < mlCoords.length; k++) {
      var d3 = turf.pointToLineDistance(pt, turf.lineString(mlCoords[k]), { units: 'meters' });
      if (d3 < mlMin) mlMin = d3;
    }
    return mlMin;
  }
  return Infinity;
}

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
        var minDist = pointToFeatureDistance(clickPoint, feature);
        if (minDist < config.requireNoBuildingNearby) {
          return { ok: false, reason: 'has a building only ' + Math.round(minDist) + 'm away — no room to widen without demolition' };
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

// =====================================================================
// RESPONSE PLAN — shared validation foundation
//
// Used ONLY by the Response Plan (the flood happening right now). It
// deliberately follows the same shape as the prevention side: declarative
// tool defs -> resolvePlacement() -> {accepted, reason} or {accepted,
// payload} -> parameter modal -> marker.
//
// The one thing prevention never needed is REAL WATER DEPTH at a point.
// The /flood response only carries a single water level plus a flat blue
// mask image, which cannot answer "is this road under 5cm or under 60cm?"
// — and that difference is exactly what decides whether a road is
// passable. So the plan page pulls the live depth grid for the CURRENT
// simulation's water level from /flood-depth-grid, and every check below
// reads that grid. Nothing here uses a hardcoded or example flood extent.
// =====================================================================

// Per-scenario rules. Only river_overflow is implemented today.
// Dam release is deliberately absent rather than defaulted: a dam surge
// moves faster and gives far less warning, so it needs its own thresholds
// instead of silently inheriting these. Supporting a new scenario means
// adding a key here — no other code below is scenario-specific.
const RESPONSE_RULES = {
  river_overflow: {
    // A road under roughly 20cm of standing water is still driveable.
    // Below this depth there is nothing to close, and closing it diverts
    // traffic for no reason. Named so the number is reviewable.
    IMPASSABLE_ROAD_DEPTH_M: 0.2,
    // How close a click must land to a road to count as "on" that road.
    ROAD_SNAP_MAX_M: 20,
    // A boat launch may sit just beside the water, not only in it.
    BOAT_WATER_ADJACENCY_M: 40,
    // A boat trailer has to be able to reach the launch point.
    BOAT_ROAD_ACCESS_MAX_M: 60,
    // Safety-critical placements need real separation from the water,
    // not merely a dry cell (see isPointOnSafeGround).
    SAFE_GROUND_CLEARANCE_M: 40,
    // A camp placed this close to a real school / community building
    // snaps onto it instead of sitting on bare ground beside it.
    SHELTER_SNAP_MAX_M: 80,
    // Beyond this a supply truck cannot reach the distribution point.
    // Surfaced as a warning, not a rejection — see resolveSupplyPoint.
    SUPPLY_ROAD_ACCESS_MAX_M: 100,
    // Minimum clear open ground a helicopter needs around the touchdown
    // point. Sized for the medium-lift airframes used for flood relief in
    // this region (~21m rotor, roughly 2x rotor for the clear area).
    OPEN_SPACE_MIN_CLEAR_RADIUS_M: 40,
    // How far around a click to look for the deepest water when siting a
    // dewatering pump.
    DEWATERING_DEEPEST_SEARCH_M: 60,
    // A diversion point has to belong to a closure it is diverting from.
    DIVERSION_MAX_FROM_CLOSURE_M: 250,
    // A warning point this close to a mosque / public building snaps onto
    // it, matching how warnings really go out in this corridor.
    WARNING_SNAP_MAX_M: 80,
    // A drawn rescue route passing this close to a road this plan has
    // closed is flagged — the backend routes on the real flood only and
    // knows nothing about closures the planner added by hand.
    CLOSURE_ON_ROUTE_M: 25,
    // Two actions of the same type closer than this are treated as
    // overlapping and are drawn so they stay tellable apart.
    SAME_TYPE_OVERLAP_M: 30,
  },
};

function getResponseRules(scenario) {
  if (!scenario || !scenario.cause_type) return null;
  return RESPONSE_RULES[scenario.cause_type] || null;
}

function scenarioLabel(scenario) {
  const meta = SCENARIO_META[scenario && scenario.cause_type];
  return meta ? meta.label : ((scenario && scenario.cause_type) || 'this scenario');
}

function formatDepth(m) {
  if (m === null || m === undefined) return '—';
  if (m < 1) return Math.round(m * 100) + 'cm';
  return m.toFixed(1) + 'm';
}

// ---------------------------------------------------------------------
// Live flood-depth grid (from /flood-depth-grid).
// Row-major from the DEM's north-west corner, whole centimetres,
// -1 meaning the DEM has no data for that cell.
// ---------------------------------------------------------------------
const FLOOD_GRID_NODATA = -1;

function floodGridMetrics(grid) {
  const west = grid.bounds[0], south = grid.bounds[1], east = grid.bounds[2], north = grid.bounds[3];
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(((north + south) / 2) * Math.PI / 180);
  return {
    mPerDegLat: mPerDegLat,
    mPerDegLon: mPerDegLon,
    cellH: ((north - south) / grid.height) * mPerDegLat,
    cellW: ((east - west) / grid.width) * mPerDegLon,
  };
}

function floodGridIndex(lat, lon, grid) {
  if (!grid) return null;
  const west = grid.bounds[0], south = grid.bounds[1], east = grid.bounds[2], north = grid.bounds[3];
  if (lon < west || lon > east || lat < south || lat > north) return null;
  let col = Math.floor(((lon - west) / (east - west)) * grid.width);
  let row = Math.floor(((north - lat) / (north - south)) * grid.height);
  col = Math.max(0, Math.min(grid.width - 1, col));
  row = Math.max(0, Math.min(grid.height - 1, row));
  return { row: row, col: col };
}

function floodDepthAtCell(row, col, grid) {
  const cm = grid.depth_cm[row * grid.width + col];
  if (cm === undefined || cm === FLOOD_GRID_NODATA) return null;
  return cm / 100;
}

function floodCellCenter(row, col, grid) {
  const west = grid.bounds[0], south = grid.bounds[1], east = grid.bounds[2], north = grid.bounds[3];
  return {
    lat: north - ((row + 0.5) / grid.height) * (north - south),
    lon: west + ((col + 0.5) / grid.width) * (east - west),
  };
}

// Scans every grid cell whose centre falls within radiusM of the point.
// Returns the deepest water found, how much of the area is wet, and how
// far away the nearest water is — enough for every "is there water near
// here / how deep / where is the deepest part" question below.
function scanFloodDepthNear(lat, lon, radiusM, grid) {
  const out = {
    hasData: false, maxDepthM: 0, wetCells: 0, dataCells: 0,
    nearestWetM: Infinity, deepestLat: null, deepestLon: null,
  };
  if (!grid) return out;

  const m = floodGridMetrics(grid);
  const center = floodGridIndex(lat, lon, grid);
  if (!center) return out;

  const rowSpan = Math.max(1, Math.ceil(radiusM / m.cellH));
  const colSpan = Math.max(1, Math.ceil(radiusM / m.cellW));

  for (let r = center.row - rowSpan; r <= center.row + rowSpan; r++) {
    if (r < 0 || r >= grid.height) continue;
    for (let c = center.col - colSpan; c <= center.col + colSpan; c++) {
      if (c < 0 || c >= grid.width) continue;
      const cell = floodCellCenter(r, c, grid);
      const dx = (cell.lon - lon) * m.mPerDegLon;
      const dy = (cell.lat - lat) * m.mPerDegLat;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radiusM) continue;

      const d = floodDepthAtCell(r, c, grid);
      if (d === null) continue;

      out.hasData = true;
      out.dataCells++;
      if (d > 0) {
        out.wetCells++;
        if (dist < out.nearestWetM) out.nearestWetM = dist;
        if (d > out.maxDepthM) {
          out.maxDepthM = d;
          out.deepestLat = cell.lat;
          out.deepestLon = cell.lon;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// FOUNDATION 1 — is this point inside the CURRENT simulation's flood
// extent, and how deep is the water there?
// ---------------------------------------------------------------------
function isPointInFloodExtent(lat, lon, scenario, geoData) {
  const grid = geoData && geoData.floodGrid;
  if (!grid) {
    return { ok: false, inFlood: false, depth_m: 0, reason: 'can\'t be checked yet — the flood depth data for this simulation is still loading' };
  }
  const cell = floodGridIndex(lat, lon, grid);
  if (!cell) {
    return { ok: false, inFlood: false, depth_m: 0, reason: 'falls outside the simulated study area' };
  }
  const depth = floodDepthAtCell(cell.row, cell.col, grid);
  if (depth === null) {
    return { ok: false, inFlood: false, depth_m: 0, reason: 'has no elevation data in this simulation' };
  }
  return { ok: true, inFlood: depth > 0, depth_m: depth };
}

// ---------------------------------------------------------------------
// FOUNDATION 2 — is this point CLEARLY outside the flood extent?
//
// "Clearly" is doing real work here. The depth grid's cells are about
// 26m x 31m of real ground, so a point that is merely dry in its own cell
// can still be a couple of metres from water. Safety-critical placements
// (shelters, medical posts) pass a clearance so they demand genuine
// separation instead of trusting one dry cell.
// ---------------------------------------------------------------------
function isPointOnSafeGround(lat, lon, scenario, geoData, clearanceM) {
  const rules = getResponseRules(scenario);
  const clearance = clearanceM !== undefined
    ? clearanceM
    : (rules ? rules.SAFE_GROUND_CLEARANCE_M : 40);

  const here = isPointInFloodExtent(lat, lon, scenario, geoData);
  if (!here.ok) {
    return { ok: false, safe: false, depth_m: 0, nearestFloodM: null, reason: here.reason };
  }
  if (here.inFlood) {
    return {
      ok: true, safe: false, depth_m: here.depth_m, nearestFloodM: 0,
      reason: 'is inside the flood extent, under ' + formatDepth(here.depth_m) + ' of water',
    };
  }

  const scan = scanFloodDepthNear(lat, lon, clearance, geoData.floodGrid);
  if (scan.wetCells > 0 && scan.nearestWetM <= clearance) {
    return {
      ok: true, safe: false, depth_m: 0, nearestFloodM: scan.nearestWetM,
      reason: 'is dry itself but only ' + Math.round(scan.nearestWetM) + 'm from floodwater (needs ' + clearance + 'm of clear ground)',
    };
  }
  return { ok: true, safe: true, depth_m: 0, nearestFloodM: scan.nearestWetM };
}

// ---------------------------------------------------------------------
// FOUNDATION 3 — nearest real road, for actions that need road access.
// ---------------------------------------------------------------------
function nearestRoad(lat, lon, maxDistanceM, geoData) {
  const roads = geoData && geoData.roadsGeoJSON;
  if (!roads || !roads.features || roads.features.length === 0) {
    return { found: false, dataMissing: true, distanceM: null };
  }
  const snapped = turf.nearestPointOnLine(roads, turf.point([lon, lat]), { units: 'meters' });
  const distanceM = snapped.properties.dist;
  // multiFeatureIndex (not .index) is the one that maps back to the
  // FeatureCollection — .index is the vertex index inside the feature.
  const feature = roads.features[snapped.properties.multiFeatureIndex];
  const props = (feature && feature.properties) || {};
  let highway = props.highway;
  if (Array.isArray(highway)) highway = highway[0];

  return {
    found: distanceM <= maxDistanceM,
    dataMissing: false,
    distanceM: distanceM,
    lat: snapped.geometry.coordinates[1],
    lon: snapped.geometry.coordinates[0],
    name: props.name || null,
    highwayType: highway || 'road',
    // roads.geojson was exported from the routing graph and carries its
    // u/v node ids, so a road picked here can be named to the backend
    // exactly — no nearest-edge guessing needed.
    u: props.u !== undefined ? props.u : null,
    v: props.v !== undefined ? props.v : null,
    feature: feature,
  };
}

// Distance from a point to any feature, in metres.
// turf.pointToLineDistance only accepts LineStrings — handing it a
// building Polygon throws — so polygons go through their boundary, and a
// point inside a polygon is distance 0.
function distanceToFeatureM(pt, feature) {
  const geomType = feature && feature.geometry && feature.geometry.type;
  if (!geomType) return Infinity;

  if (geomType === 'Point') {
    return turf.distance(pt, feature, { units: 'meters' });
  }
  if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
    if (turf.booleanPointInPolygon(pt, feature)) return 0;
    try {
      return turf.nearestPointOnLine(turf.polygonToLine(feature), pt, { units: 'meters' }).properties.dist;
    } catch (err) {
      return Infinity;
    }
  }
  if (geomType === 'LineString' || geomType === 'MultiLineString') {
    return turf.nearestPointOnLine(feature, pt, { units: 'meters' }).properties.dist;
  }
  return Infinity;
}

function floodClearanceText(nearestFloodM) {
  if (nearestFloodM === null || nearestFloodM === undefined || !isFinite(nearestFloodM)) {
    return 'clear of the flood';
  }
  return Math.round(nearestFloodM) + 'm clear of the flood';
}

function roadDescription(road) {
  if (!road) return 'that road';
  if (road.name) return road.name;
  return 'that ' + String(road.highwayType).replace(/_/g, ' ');
}

// ---------------------------------------------------------------------
// FOUNDATION 4 — open ground (Green Spaces layer) with a genuinely clear
// radius around it and no building on top. Built now because it is part
// of the shared foundation; first used by the Phase 3 helicopter zone.
// ---------------------------------------------------------------------
function isPointInOpenSpace(lat, lon, geoData, minClearRadiusM) {
  const greenery = geoData && geoData.greeneryGeoJSON;
  const buildings = geoData && geoData.buildingsGeoJSON;
  const pt = turf.point([lon, lat]);

  if (!greenery || !greenery.features || greenery.features.length === 0) {
    return { open: false, dataMissing: true, reason: 'can\'t be checked — the green spaces layer has not loaded' };
  }

  // Green spaces overlap — a point can sit inside a small playground AND
  // inside the national park polygon that surrounds it. Collect every
  // space that contains the point rather than stopping at the first,
  // because the clear-radius test below only needs ONE of them to be big
  // enough.
  const containingSpaces = [];
  for (const feature of greenery.features) {
    const geomType = feature.geometry && feature.geometry.type;
    if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') continue;
    if (turf.booleanPointInPolygon(pt, feature)) containingSpaces.push(feature);
  }
  if (containingSpaces.length === 0) {
    return { open: false, reason: 'is not on mapped open ground — pick a park, field or other green space' };
  }

  function nameOf(feature) {
    const props = feature.properties || {};
    return props.name || props.leisure || props.landuse || 'open ground';
  }
  const spaceName = nameOf(containingSpaces[0]);

  if (buildings && buildings.features) {
    // Centroids (index-aligned with features) let us skip the vast
    // majority of buildings without touching their geometry. 400m is a
    // generous allowance for the half-width of any building here.
    const centroids = geoData.buildingPoints;
    const CENTROID_PREFILTER_M = minClearRadiusM + 400;

    for (let i = 0; i < buildings.features.length; i++) {
      const feature = buildings.features[i];
      const centroid = centroids && centroids[i];
      if (centroid &&
          turf.distance(pt, turf.point(centroid), { units: 'meters' }) > CENTROID_PREFILTER_M) {
        continue;
      }
      const dist = distanceToFeatureM(pt, feature);
      if (dist < minClearRadiusM) {
        return {
          open: false, spaceName: spaceName,
          reason: dist === 0
            ? 'lands on a building, not clear ground'
            : 'has a building only ' + Math.round(dist) + 'm away — needs ' + minClearRadiusM + 'm clear all round',
        };
      }
    }
  }

  // The clear radius must actually fit inside the open space, not just
  // start inside it — a 10m strip of park is not a landing zone.
  const circle = turf.circle([lon, lat], minClearRadiusM / 1000, { steps: 32, units: 'kilometers' });
  for (const space of containingSpaces) {
    let fits = false;
    try {
      fits = turf.booleanContains(space, circle);
    } catch (err) {
      fits = false;
    }
    if (fits) {
      return { open: true, spaceName: nameOf(space), clearRadiusM: minClearRadiusM };
    }
  }

  return {
    open: false, spaceName: spaceName,
    reason: 'is on ' + spaceName + ', but no mapped open space there is large enough to hold a ' +
      minClearRadiusM + 'm clear radius around the click',
  };
}

// ---------------------------------------------------------------------
// Overlap awareness.
//
// The prevention actions have no overlap detection at all — two ponds
// stacked on the same spot are indistinguishable on the map. Response
// markers record how many same-type markers are already within the
// overlap distance, and the renderer uses that to fan them out visually
// and number them. The stored lat/lon is always the true click point;
// only the drawn icon is nudged.
// ---------------------------------------------------------------------
function findNearbySameType(lat, lon, type, existingMarkers, thresholdM) {
  if (!existingMarkers || existingMarkers.length === 0) return [];
  const pt = turf.point([lon, lat]);
  return existingMarkers.filter(function (m) {
    if (m.type !== type) return false;
    return turf.distance(pt, turf.point([m.lon, m.lat]), { units: 'meters' }) <= thresholdM;
  });
}

// ---------------------------------------------------------------------
// Shared precondition for every response placement: a supported
// scenario, and the live depth grid actually loaded and current.
// ---------------------------------------------------------------------
function checkResponseReady(toolDef, geoData) {
  const scenario = geoData && geoData.scenario;
  const rules = getResponseRules(scenario);
  if (!rules) {
    return {
      accepted: false,
      reason: 'Response-plan validation is only implemented for River Overflow so far. This simulation is ' +
        scenarioLabel(scenario) + ', which needs its own thresholds (different warning time and water behaviour), so placements are blocked rather than checked against the wrong rules.',
    };
  }
  if (!geoData.floodGrid) {
    return { accepted: false, reason: 'Still loading this simulation\'s flood depth data — try again in a moment.' };
  }
  if (geoData.floodGrid.water_level_m !== scenario.water_level_m) {
    return { accepted: false, reason: 'The loaded flood depth data is from a different water level than the current simulation. Reload the plan before placing actions.' };
  }
  return null;
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 1 — Close flooded road
//
// Valid only when the click lands on a real road AND that road is under
// water AND the water is deep enough to actually stop traffic. The red
// "flooded roads" layer from the simulation counts any road with water
// above 0m, so it alone is not sufficient — a road under 3cm is still
// open, and closing it would divert traffic for nothing.
// ---------------------------------------------------------------------
function resolveCloseFloodedRoad(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);

  const road = nearestRoad(lngLat.lat, lngLat.lng, rules.ROAD_SNAP_MAX_M, geoData);
  if (road.dataMissing) {
    return { accepted: false, reason: 'Road data has not loaded — can\'t confirm a road is there.' };
  }
  if (!road.found) {
    return {
      accepted: false,
      reason: 'That click is ' + Math.round(road.distanceM) + 'm from the nearest road — click directly on the road you want to close.',
    };
  }

  // Depth is measured ON THE ROAD, at the snapped point, not at the raw
  // click — otherwise a click landing in water beside a dry road would
  // close a road that is not actually flooded.
  const flood = isPointInFloodExtent(road.lat, road.lon, scenario, geoData);
  if (!flood.ok) {
    return { accepted: false, reason: 'That road ' + flood.reason + '.' };
  }

  if (!flood.inFlood) {
    const scan = scanFloodDepthNear(road.lat, road.lon, 200, geoData.floodGrid);
    const near = scan.wetCells > 0
      ? ' The nearest floodwater is about ' + Math.round(scan.nearestWetM) + 'm away.'
      : '';
    return {
      accepted: false,
      reason: roadDescription(road) + ' is not in the current flood extent — there is nothing to close here.' + near,
    };
  }

  if (flood.depth_m < rules.IMPASSABLE_ROAD_DEPTH_M) {
    return {
      accepted: false,
      reason: 'Water on ' + roadDescription(road) + ' is only ' + formatDepth(flood.depth_m) +
        ' deep — under the ' + formatDepth(rules.IMPASSABLE_ROAD_DEPTH_M) + ' impassable threshold, so it is still driveable. Closing it would divert traffic for nothing.',
    };
  }

  const already = (geoData.closedRoads || []).some(function (r) {
    if (r.lat === undefined || r.lat === null) return false;
    return turf.distance(turf.point([road.lon, road.lat]), turf.point([r.lon, r.lat]), { units: 'meters' }) <= rules.SAME_TYPE_OVERLAP_M;
  });
  if (already) {
    return { accepted: false, reason: roadDescription(road) + ' is already closed in this plan at that point.' };
  }

  return {
    accepted: true,
    payload: {
      lng: road.lon,
      lat: road.lat,
      roadName: road.name,
      roadHighwayType: road.highwayType,
      roadDistanceM: road.distanceM,
      roadU: road.u,
      roadV: road.v,
      depthM: flood.depth_m,
      floodedRoadIndex: matchFloodedRoadIndex(road.lat, road.lon, geoData),
      snappedToRoad: true,
    },
  };
}

// Ties a closure back to the simulation's own red flooded-road line, so
// the existing "turns black when closed" rendering keeps working.
// Returns null when the clicked road is not one the simulation flagged.
function matchFloodedRoadIndex(lat, lon, geoData) {
  const fc = geoData && geoData.floodedRoadsGeoJSON;
  if (!fc || !fc.features || fc.features.length === 0) return null;
  const snapped = turf.nearestPointOnLine(fc, turf.point([lon, lat]), { units: 'meters' });
  if (snapped.properties.dist > 25) return null;
  const feature = fc.features[snapped.properties.multiFeatureIndex];
  return feature && feature.properties ? feature.properties.roadIndex : null;
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 2 — Boat launch point
//
// Needs water to launch into AND a road to get the trailer there.
// ---------------------------------------------------------------------
function resolveBoatLaunch(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);

  const here = isPointInFloodExtent(lngLat.lat, lngLat.lng, scenario, geoData);
  if (!here.ok) {
    return { accepted: false, reason: 'That point ' + here.reason + '.' };
  }

  const scan = scanFloodDepthNear(lngLat.lat, lngLat.lng, rules.BOAT_WATER_ADJACENCY_M, geoData.floodGrid);
  const hasWater = here.inFlood || scan.wetCells > 0;
  const road = nearestRoad(lngLat.lat, lngLat.lng, rules.BOAT_ROAD_ACCESS_MAX_M, geoData);

  if (!hasWater && !road.found) {
    return {
      accepted: false,
      reason: 'That point is dry land with no floodwater within ' + rules.BOAT_WATER_ADJACENCY_M +
        'm and no road within ' + rules.BOAT_ROAD_ACCESS_MAX_M + 'm — nothing to launch into, and no way to get a boat there.',
    };
  }
  if (!hasWater) {
    return {
      accepted: false,
      reason: 'That point is dry — no floodwater within ' + rules.BOAT_WATER_ADJACENCY_M +
        'm. A launch point has to touch the water.',
    };
  }
  if (road.dataMissing) {
    return { accepted: false, reason: 'Road data has not loaded — can\'t confirm trailer access.' };
  }
  if (!road.found) {
    return {
      accepted: false,
      reason: 'There is water here (' + formatDepth(Math.max(here.depth_m, scan.maxDepthM)) + ' deep nearby) but the nearest road is ' +
        Math.round(road.distanceM) + 'm away — a boat trailer can\'t reach it. The limit is ' + rules.BOAT_ROAD_ACCESS_MAX_M + 'm.',
    };
  }

  return {
    accepted: true,
    payload: {
      lng: lngLat.lng,
      lat: lngLat.lat,
      depthM: here.depth_m,
      maxDepthNearbyM: scan.maxDepthM,
      atWaterEdge: !here.inFlood,
      waterDistanceM: here.inFlood ? 0 : scan.nearestWetM,
      roadName: road.name,
      roadHighwayType: road.highwayType,
      roadDistanceM: road.distanceM,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 3 — Priority evacuation zone
//
// An AREA, not a point. The existing code has no polygon drawing (the
// only non-point geometry anywhere is the embankment's generated line),
// so the zone is a radius around the click.
//
// The zone has no placement rejection beyond being inside the simulated
// area — an evacuation zone is a decision about people, not about
// terrain. What it must do is report honestly what falls inside it.
// ---------------------------------------------------------------------
const EVAC_HOSPITAL_AMENITIES = ['hospital', 'clinic', 'doctors'];

function resolveEvacuationZone(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const here = isPointInFloodExtent(lngLat.lat, lngLat.lng, scenario, geoData);
  if (!here.ok) {
    return { accepted: false, reason: 'That point ' + here.reason + '.' };
  }
  return {
    accepted: true,
    payload: { lng: lngLat.lng, lat: lngLat.lat, depthM: here.depth_m },
  };
}

// Everything inside the zone, read from the live simulation and the real
// Buildings / Hospitals layers. Called live as the radius is typed, and
// again on submit, so what the popup shows is what gets recorded.
function computeEvacuationZoneStats(lat, lon, radiusM, scenario, geoData) {
  const stats = {
    radiusM: radiusM,
    maxDepthM: 0,
    floodedPercent: 0,
    buildingCount: 0,
    hospitals: [],
    critical: false,
  };
  if (!radiusM || radiusM <= 0) return stats;

  const scan = scanFloodDepthNear(lat, lon, radiusM, geoData.floodGrid);
  stats.maxDepthM = scan.maxDepthM;
  stats.floodedPercent = scan.dataCells > 0 ? Math.round((scan.wetCells / scan.dataCells) * 100) : 0;

  const center = turf.point([lon, lat]);

  stats.buildingCount = countBuildingsWithin(lat, lon, radiusM, geoData);

  const facilities = geoData.facilitiesGeoJSON;
  if (facilities && facilities.features) {
    for (const feature of facilities.features) {
      const amenity = feature.properties && feature.properties.amenity;
      if (EVAC_HOSPITAL_AMENITIES.indexOf(amenity) === -1) continue;
      const c = featureCentroidLonLat(feature);
      if (!c) continue;
      if (turf.distance(center, turf.point(c), { units: 'meters' }) <= radiusM) {
        stats.hospitals.push((feature.properties && feature.properties.name) || ('Unnamed ' + amenity));
      }
    }
  }

  // A hospital inside the zone means patients who cannot self-evacuate.
  stats.critical = stats.hospitals.length > 0;
  return stats;
}

// Same centroid rule the backend uses for facilities, so frontend and
// backend agree on where a polygon facility "is".
function featureCentroidLonLat(feature) {
  const geom = feature && feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return [geom.coordinates[0], geom.coordinates[1]];
  let ring = null;
  if (geom.type === 'Polygon') ring = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') ring = geom.coordinates[0][0];
  if (!ring || ring.length === 0) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
  return [sx / ring.length, sy / ring.length];
}

// =====================================================================
// PHASE 2 — safe-zone logistics (shelters, medical posts, supplies)
//
// All three put PEOPLE somewhere for an extended period, so all three
// share one hard rule: the site must be clear of the flood. That rule is
// enforced by requireSafeGround() below and is never bypassed — the
// differences between the three actions are only in what extra context
// each one surfaces.
// =====================================================================

// The same set the map page's "Schools / shelters" layer draws.
const SHELTER_AMENITIES = ['school', 'college', 'university', 'community_centre', 'shelter', 'place_of_worship'];

// Nearest facility of the given amenity types, by real centroid.
// maxDistanceM only decides the `found` flag — the distance is always
// returned, so callers can report "nearest hospital is 1.2km away".
function nearestFacility(lat, lon, amenityTypes, geoData, maxDistanceM) {
  const facilities = geoData && geoData.facilitiesGeoJSON;
  if (!facilities || !facilities.features || facilities.features.length === 0) {
    return { found: false, dataMissing: true, distanceM: null };
  }
  const pt = turf.point([lon, lat]);
  let best = null;

  for (const feature of facilities.features) {
    const amenity = feature.properties && feature.properties.amenity;
    if (amenityTypes.indexOf(amenity) === -1) continue;
    const c = featureCentroidLonLat(feature);
    if (!c) continue;
    const distanceM = turf.distance(pt, turf.point(c), { units: 'meters' });
    if (!best || distanceM < best.distanceM) {
      best = {
        distanceM: distanceM,
        lon: c[0],
        lat: c[1],
        name: (feature.properties && feature.properties.name) || null,
        amenity: amenity,
        feature: feature,
      };
    }
  }

  if (!best) return { found: false, dataMissing: false, distanceM: null };
  best.found = maxDistanceM === undefined || best.distanceM <= maxDistanceM;
  best.dataMissing = false;
  return best;
}

function amenityLabel(amenity) {
  return String(amenity || 'site').replace(/_/g, ' ');
}

function facilityDescription(f) {
  if (!f) return 'a site';
  if (f.name) return f.name;
  return 'an unnamed ' + amenityLabel(f.amenity);
}

// ---------------------------------------------------------------------
// The shared safety rule for every Phase 2 action.
//
// This is stricter than "the clicked cell is dry", deliberately. Depth
// cells are ~26m x 31m of real ground, so a cell can read dry while open
// water sits a few metres inside it. A camp, a medical post or a food
// queue is somewhere people stand for hours, often at night, with the
// water still rising — a single dry cell is not evidence of a safe site.
// SAFE_GROUND_CLEARANCE_M is the margin, and the rejection always says
// which of the two conditions failed.
// ---------------------------------------------------------------------
function requireSafeGround(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const ground = isPointOnSafeGround(lngLat.lat, lngLat.lng, scenario, geoData);

  if (!ground.ok) {
    return { rejection: { accepted: false, reason: 'That point ' + ground.reason + '.' } };
  }
  if (!ground.safe) {
    const what = toolDef.safetyNoun || 'site';
    return {
      rejection: {
        accepted: false,
        reason: 'That point ' + ground.reason + '. A ' + what + ' has to be on ground the water cannot reach — pick a spot further from the blue area.',
      },
    };
  }
  return { ground: ground };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 4 — Relief camp / shelter
//
// Must be clear of the flood, no exceptions. If a real school, community
// centre or similar sits close by, the camp snaps onto it — using a
// building that already has walls, water and toilets beats pitching on
// open ground. The snap target is itself re-checked for safe ground, so
// snapping can never pull a camp toward the water.
// ---------------------------------------------------------------------
function resolveReliefCamp(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);

  const safe = requireSafeGround(lngLat, toolDef, geoData);
  if (safe.rejection) return safe.rejection;

  let snapped = null;
  const candidate = nearestFacility(lngLat.lat, lngLat.lng, SHELTER_AMENITIES, geoData, rules.SHELTER_SNAP_MAX_M);
  if (candidate.found) {
    const candidateGround = isPointOnSafeGround(candidate.lat, candidate.lon, scenario, geoData);
    if (candidateGround.ok && candidateGround.safe) {
      snapped = candidate;
    }
  }

  const site = snapped || { lat: lngLat.lat, lon: lngLat.lng };
  const ground = snapped
    ? isPointOnSafeGround(snapped.lat, snapped.lon, scenario, geoData)
    : safe.ground;

  return {
    accepted: true,
    payload: {
      lng: site.lon,
      lat: site.lat,
      nearestFloodM: ground.nearestFloodM,
      snappedFacilityName: snapped ? facilityDescription(snapped) : null,
      snappedFacilityAmenity: snapped ? snapped.amenity : null,
      snapDistanceM: snapped ? snapped.distanceM : null,
      // Recorded even when we did NOT snap, so the popup can say why.
      rejectedSnapReason: (!snapped && candidate.found)
        ? 'the nearest ' + amenityLabel(candidate.amenity) + ' is itself too close to the water'
        : null,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 5 — Medical / first-aid post
//
// Same hard safety rule. The distance to the nearest real hospital is
// reference information only: it tells the planner whether this post is
// filling a genuine gap or duplicating a hospital that is still standing.
// It never blocks the placement.
// ---------------------------------------------------------------------
function resolveMedicalPost(lngLat, toolDef, geoData) {
  const safe = requireSafeGround(lngLat, toolDef, geoData);
  if (safe.rejection) return safe.rejection;

  const hospital = nearestFacility(lngLat.lat, lngLat.lng, EVAC_HOSPITAL_AMENITIES, geoData);

  return {
    accepted: true,
    payload: {
      lng: lngLat.lng,
      lat: lngLat.lat,
      nearestFloodM: safe.ground.nearestFloodM,
      nearestHospitalName: hospital.distanceM !== null ? facilityDescription(hospital) : null,
      nearestHospitalM: hospital.distanceM,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 6 — Food & water distribution
//
// Same hard safety rule. Road access is surfaced but does NOT block:
// supplies can be carried the last stretch on foot, and a distribution
// point sited for where people actually are can be the right call even
// when a truck cannot pull up to it. The popup says which case this is.
// ---------------------------------------------------------------------
function resolveSupplyPoint(lngLat, toolDef, geoData) {
  const rules = getResponseRules(geoData.scenario);

  const safe = requireSafeGround(lngLat, toolDef, geoData);
  if (safe.rejection) return safe.rejection;

  const road = nearestRoad(lngLat.lat, lngLat.lng, rules.SUPPLY_ROAD_ACCESS_MAX_M, geoData);

  return {
    accepted: true,
    payload: {
      lng: lngLat.lng,
      lat: lngLat.lat,
      nearestFloodM: safe.ground.nearestFloodM,
      roadReachable: !road.dataMissing && road.found,
      roadName: road.dataMissing ? null : road.name,
      roadHighwayType: road.dataMissing ? null : road.highwayType,
      roadDistanceM: road.dataMissing ? null : road.distanceM,
    },
  };
}

// Shared popup line: how much clear ground stands between this site and
// the water. Infinity means nothing wet was found within the scan.
function floodClearanceLine(nearestFloodM, rules) {
  if (nearestFloodM === null || nearestFloodM === undefined || !isFinite(nearestFloodM)) {
    return { label: 'Flood clearance', value: 'no floodwater within ' + rules.SAFE_GROUND_CLEARANCE_M + 'm', tone: 'good' };
  }
  return { label: 'Flood clearance', value: Math.round(nearestFloodM) + 'm from the nearest floodwater', tone: 'good' };
}

// =====================================================================
// PHASE 3 — specialised terrain actions
// =====================================================================

// Counting buildings inside a radius is needed by evacuation zones,
// warning coverage and anything else that asks "how many people does
// this cover?", so it lives in one place.
function countBuildingsWithin(lat, lon, radiusM, geoData) {
  const buildingPoints = geoData.buildingPoints || [];
  const center = turf.point([lon, lat]);
  let count = 0;
  for (let i = 0; i < buildingPoints.length; i++) {
    const b = buildingPoints[i];
    if (!b) continue;
    if (turf.distance(center, turf.point([b[0], b[1]]), { units: 'meters' }) <= radiusM) count++;
  }
  return count;
}

// ROUGH population estimate, and labelled as one everywhere it appears.
// 6.5 is the average household size reported by the Pakistan Bureau of
// Statistics (2017 census). It is applied per mapped building, which
// over-counts where buildings are shops or sheds and under-counts where
// one footprint holds several households — so it is only ever shown as
// an approximation beside the real, counted building figure.
const PEOPLE_PER_BUILDING_ESTIMATE = 6.5;

function estimatePeople(buildingCount) {
  return Math.round(buildingCount * PEOPLE_PER_BUILDING_ESTIMATE);
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 7 — Dewatering pump
//
// A pump belongs where the water actually pools, not on the shallow rim
// of the flood where a click most easily lands. The click is therefore
// SNAPPED to the deepest cell within DEWATERING_DEEPEST_SEARCH_M, and
// the popup says how far it moved and what that bought — so the planner
// sees the correction rather than having the placement quietly shifted.
// ---------------------------------------------------------------------
function resolveDewatering(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);

  const here = isPointInFloodExtent(lngLat.lat, lngLat.lng, scenario, geoData);
  if (!here.ok) {
    return { accepted: false, reason: 'That point ' + here.reason + '.' };
  }
  if (!here.inFlood) {
    const scan = scanFloodDepthNear(lngLat.lat, lngLat.lng, 200, geoData.floodGrid);
    const near = scan.wetCells > 0
      ? ' The nearest standing water is about ' + Math.round(scan.nearestWetM) + 'm away.'
      : '';
    return {
      accepted: false,
      reason: 'There is no floodwater at that point — a pump has nothing to remove here.' + near,
    };
  }

  const scan = scanFloodDepthNear(lngLat.lat, lngLat.lng, rules.DEWATERING_DEEPEST_SEARCH_M, geoData.floodGrid);

  // Fall back to the click itself if the scan somehow found nothing
  // deeper (it always should, since the click cell is inside the scan).
  const targetLat = scan.deepestLat !== null ? scan.deepestLat : lngLat.lat;
  const targetLon = scan.deepestLon !== null ? scan.deepestLon : lngLat.lng;
  const movedM = turf.distance(
    turf.point([lngLat.lng, lngLat.lat]),
    turf.point([targetLon, targetLat]),
    { units: 'meters' }
  );

  return {
    accepted: true,
    payload: {
      lng: targetLon,
      lat: targetLat,
      clickDepthM: here.depth_m,
      depthM: Math.max(here.depth_m, scan.maxDepthM),
      movedToDeepestM: movedM,
      searchRadiusM: rules.DEWATERING_DEEPEST_SEARCH_M,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 8 — Helicopter landing zone
//
// Two hard rules, both settled deliberately rather than by default:
//
//  1. NEVER inside the flood extent. The depth grid is 1m-granular on
//     ~26m x 31m cells, so it cannot tell 10cm on tarmac from a metre
//     over soft ground, and real flood operations winch from a hover
//     rather than touching down in water. A hover/winch point is a
//     different thing from a landing zone and is not modelled here.
//  2. Open ground only, with a clear radius that genuinely fits inside
//     the mapped space — sized for the medium-lift airframes used in
//     flood relief in this region (~21m rotor, ~2x rotor clear area).
//
// The flood check runs first because it is the safety rule; the reason
// always names which condition failed.
// ---------------------------------------------------------------------
function resolveHelipad(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);
  const radius = rules.OPEN_SPACE_MIN_CLEAR_RADIUS_M;

  const here = isPointInFloodExtent(lngLat.lat, lngLat.lng, scenario, geoData);
  if (!here.ok) {
    return { accepted: false, reason: 'That point ' + here.reason + '.' };
  }
  if (here.inFlood) {
    return {
      accepted: false,
      reason: 'That point is under ' + formatDepth(here.depth_m) +
        ' of water. Landing zones must be on dry ground — this tool does not mark hover or winch points.',
    };
  }

  const open = isPointInOpenSpace(lngLat.lat, lngLat.lng, geoData, radius);
  if (open.dataMissing) {
    return { accepted: false, reason: 'The green spaces layer has not loaded — can’t confirm open ground.' };
  }
  if (!open.open) {
    return { accepted: false, reason: 'That point ' + open.reason + '.' };
  }

  // The clear radius sits on dry ground, not just the centre point.
  const edgeScan = scanFloodDepthNear(lngLat.lat, lngLat.lng, radius, geoData.floodGrid);
  if (edgeScan.wetCells > 0) {
    return {
      accepted: false,
      reason: 'The touchdown point is dry, but floodwater reaches to within ' +
        Math.round(edgeScan.nearestWetM) + 'm — inside the ' + radius + 'm clear radius a landing zone needs.',
    };
  }

  return {
    accepted: true,
    payload: {
      lng: lngLat.lng,
      lat: lngLat.lat,
      spaceName: open.spaceName,
      clearRadiusM: radius,
      nearestFloodM: edgeScan.nearestWetM,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 9 — Traffic diversion point
//
// A diversion only means something next to a closure it is diverting
// traffic away from, so it requires an existing "Close flooded road"
// entry within DIVERSION_MAX_FROM_CLOSURE_M. It snaps onto the road when
// one is close by (that is where a diversion physically happens) but a
// missing road is NOT a rejection — the only rule is the closure one.
// ---------------------------------------------------------------------
function resolveDiversion(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);
  const closures = geoData.closedRoads || [];

  const placed = closures.filter(function (r) { return r.lat !== undefined && r.lat !== null; });
  if (placed.length === 0) {
    return {
      accepted: false,
      reason: 'There are no road closures in this plan yet. Add a road closure near here first — a diversion has to divert traffic away from something.',
    };
  }

  const pt = turf.point([lngLat.lng, lngLat.lat]);
  let nearestClosure = null;
  for (const r of placed) {
    const distanceM = turf.distance(pt, turf.point([r.lon, r.lat]), { units: 'meters' });
    if (!nearestClosure || distanceM < nearestClosure.distanceM) {
      nearestClosure = { distanceM: distanceM, closure: r };
    }
  }

  if (nearestClosure.distanceM > rules.DIVERSION_MAX_FROM_CLOSURE_M) {
    return {
      accepted: false,
      reason: 'The nearest road closure in this plan is ' + Math.round(nearestClosure.distanceM) +
        'm away, beyond the ' + rules.DIVERSION_MAX_FROM_CLOSURE_M + 'm limit. Add a road closure near here first.',
    };
  }

  // Snap onto the road when there is one — a diversion happens at a
  // junction, not in a field. No road nearby is not a rejection.
  const road = nearestRoad(lngLat.lat, lngLat.lng, rules.ROAD_SNAP_MAX_M, geoData);
  const onRoad = !road.dataMissing && road.found;
  const site = onRoad ? { lat: road.lat, lon: road.lon } : { lat: lngLat.lat, lon: lngLat.lng };

  // A diversion that sends traffic into water is worth seeing. Reported,
  // not blocked — the closure rule is the only rule here.
  const siteFlood = isPointInFloodExtent(site.lat, site.lon, scenario, geoData);

  return {
    accepted: true,
    payload: {
      lng: site.lon,
      lat: site.lat,
      onRoad: onRoad,
      roadName: onRoad ? road.name : null,
      roadHighwayType: onRoad ? road.highwayType : null,
      roadDistanceM: road.dataMissing ? null : road.distanceM,
      closureDistanceM: nearestClosure.distanceM,
      closureU: nearestClosure.closure.roadU !== undefined ? nearestClosure.closure.roadU : null,
      closureV: nearestClosure.closure.roadV !== undefined ? nearestClosure.closure.roadV : null,
      divertingFrom: nearestClosure.closure.roadName ||
        (nearestClosure.closure.roadHighwayType
          ? amenityLabel(nearestClosure.closure.roadHighwayType) + ' closure'
          : 'a road closure'),
      selfFlooded: siteFlood.ok && siteFlood.inFlood,
      selfFloodDepthM: siteFlood.ok ? siteFlood.depth_m : null,
    },
  };
}

// ---------------------------------------------------------------------
// RESPONSE ACTION 10 — Warning announcement point
//
// Snaps onto a mosque or other public building when one is close, which
// is what the tool's own guidance describes — loudspeaker warnings in
// this corridor really do go out through mosque PA systems. The snap
// never blocks. Coverage is a radius the planner sets.
// ---------------------------------------------------------------------
const WARNING_SNAP_AMENITIES = ['place_of_worship', 'community_centre', 'school', 'college', 'university'];

function resolveWarningPoint(lngLat, toolDef, geoData) {
  const scenario = geoData.scenario;
  const rules = getResponseRules(scenario);

  const here = isPointInFloodExtent(lngLat.lat, lngLat.lng, scenario, geoData);
  if (!here.ok) {
    return { accepted: false, reason: 'That point ' + here.reason + '.' };
  }

  const candidate = nearestFacility(lngLat.lat, lngLat.lng, WARNING_SNAP_AMENITIES, geoData, rules.WARNING_SNAP_MAX_M);
  const snapped = candidate.found ? candidate : null;
  const site = snapped || { lat: lngLat.lat, lon: lngLat.lng };
  const siteFlood = snapped
    ? isPointInFloodExtent(snapped.lat, snapped.lon, scenario, geoData)
    : here;

  return {
    accepted: true,
    payload: {
      lng: site.lon,
      lat: site.lat,
      snappedFacilityName: snapped ? facilityDescription(snapped) : null,
      snappedFacilityAmenity: snapped ? snapped.amenity : null,
      snapDistanceM: snapped ? snapped.distanceM : null,
      // A siren standing in the water is still a real placement decision,
      // but the operator should see it.
      selfFlooded: siteFlood.ok && siteFlood.inFlood,
      selfFloodDepthM: siteFlood.ok ? siteFlood.depth_m : null,
    },
  };
}

// What a warning at this point actually reaches. Counted from the real
// Buildings layer; the people figure is an explicit estimate.
function computeWarningCoverage(lat, lon, radiusM, geoData) {
  const coverage = { radiusM: radiusM, buildingCount: 0, estimatedPeople: 0 };
  if (!radiusM || radiusM <= 0) return coverage;
  coverage.buildingCount = countBuildingsWithin(lat, lon, radiusM, geoData);
  coverage.estimatedPeople = estimatePeople(coverage.buildingCount);
  return coverage;
}

// ---------------------------------------------------------------------
// Generic helpers for the config-driven prevention action flow.
// ---------------------------------------------------------------------

var _nextUid = 1;
function nextUid() { return _nextUid++; }

function buildDefaultForms() {
  const defaults = {};
  PREVENTION_TOOLS.concat(RESPONSE_TOOLS).concat(CUSTOM_ACTIONS).forEach(function (tool) {
    if (!tool.formFields) return;
    const form = {};
    tool.formFields.forEach(function (f) { if (f.default !== undefined) form[f.key] = f.default; });
    defaults[tool.key] = form;
  });
  return defaults;
}

function validateFormFields(forms, toolDef) {
  if (!toolDef || !toolDef.formFields) return null;
  for (var i = 0; i < toolDef.formFields.length; i++) {
    var f = toolDef.formFields[i];
    if (f.type !== 'number') continue;
    var val = Number(forms[f.key]);
    if (isNaN(val) || val <= 0) {
      return 'Enter a positive ' + f.label.toLowerCase() + ' before continuing.';
    }
    if (f.min !== undefined && val < f.min) {
      return f.label + ' must be at least ' + f.min + (f.unit ? ' ' + f.unit : '') + '.';
    }
    if (f.max !== undefined && val > f.max) {
      return f.label + ' must be at most ' + f.max + (f.unit ? ' ' + f.unit : '') + '.';
    }
  }
  return null;
}

function resolvePlacement(lngLat, toolDef, geoData) {
  const { waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON } = geoData;

  // Response actions validate against the LIVE flood depth grid, so they
  // share one precondition check before any of them runs.
  const RESPONSE_RESOLVERS = {
    floodedRoad: resolveCloseFloodedRoad,
    boatLaunch: resolveBoatLaunch,
    evacuationZone: resolveEvacuationZone,
    reliefCamp: resolveReliefCamp,
    medicalPost: resolveMedicalPost,
    supplyPoint: resolveSupplyPoint,
    dewatering: resolveDewatering,
    helipad: resolveHelipad,
    diversion: resolveDiversion,
    warningPoint: resolveWarningPoint,
  };
  const responseResolver = RESPONSE_RESOLVERS[toolDef.targetType];
  if (responseResolver) {
    const notReady = checkResponseReady(toolDef, geoData);
    if (notReady) return notReady;
    return responseResolver(lngLat, toolDef, geoData);
  }

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
  // Measured facts from a response placement (depth, road access, zone
  // contents). Kept on the marker so the plan list shows what was
  // actually checked, not just what was clicked.
  if (payload.info) marker.info = payload.info;
  if (payload.stackIndex) marker.stackIndex = payload.stackIndex;
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
  desilt: ['desilt', 'mud', 'sediment', 'silt', 'dredge', 'dig', 'excavate', 'clean waterway', 'waterway bed'],
  clearDrains: ['drain', 'blocked', 'clear', 'unclog', 'choke', 'debris', 'clean drain'],
  embankment: ['embankment', 'levee', 'raise bank', 'protective bank', 'bund', 'barrier along'],
  widenChannel: ['widen', 'broaden', 'expand channel', 'narrow', 'channel width'],
  removeEncroachment: ['encroachment', 'illegal', 'demolish', 'structure blocking', 'blocking structure', 'remove building'],
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
    label: 'Raise Road Level',
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
  closeRoad: {
    phases: [
      { emoji: '🚧', text: 'Closing road…' },
      { emoji: '⛔', text: 'Road closed' },
    ],
    phaseMs: 1000,
  },
  boatLaunch: {
    phases: [
      { emoji: '🛟', text: 'Marking launch point…' },
      { emoji: '🚤', text: 'Launch point set' },
    ],
    phaseMs: 1000,
  },
  evacuationZone: {
    phases: [
      { emoji: '⚠️', text: 'Marking zone…' },
      { emoji: '🚨', text: 'Evacuation zone set' },
    ],
    phaseMs: 1000,
  },
  reliefCamp: {
    phases: [
      { emoji: '🏕️', text: 'Siting shelter…' },
      { emoji: '✅', text: 'Shelter sited' },
    ],
    phaseMs: 1000,
  },
  medicalPost: {
    phases: [
      { emoji: '🚑', text: 'Setting up post…' },
      { emoji: '⚕️', text: 'Medical post ready' },
    ],
    phaseMs: 1000,
  },
  supplyPoint: {
    phases: [
      { emoji: '🥢', text: 'Siting distribution…' },
      { emoji: '✅', text: 'Distribution point set' },
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
  const facilitiesDataRef = useRef(null);
  const greeneryDataRef = useRef(null);
  // Pre-computed [lon, lat] per building, so counting buildings inside an
  // evacuation zone stays cheap while the radius is being typed.
  const buildingPointsRef = useRef(null);
  const floodedRoadsFCRef = useRef(null);
  // Live per-cell water depth for THIS simulation's water level.
  const floodGridRef = useRef(null);

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
  const [floodGridStatus, setFloodGridStatus] = useState('loading');
  const [toolNotice, setToolNotice] = useState(null);
  const [uncheckedHospitals, setUncheckedHospitals] = useState([]);
  // Route geometry is held in state (not written straight to the map) so a
  // route can be re-drawn as stale without being recalculated.
  const [routeGeo, setRouteGeo] = useState(null);
  const [routeAlertDismissed, setRouteAlertDismissed] = useState(false);
  // Set when the simulation in sessionStorage is no longer the one this
  // plan was opened with.
  const [scenarioDrift, setScenarioDrift] = useState(null);
  const [diversionCheck, setDiversionCheck] = useState(null);
  // Bumped to re-run the hospital access sweep on demand.
  const [accessCheckToken, setAccessCheckToken] = useState(0);
  const [sweepClosureCount, setSweepClosureCount] = useState(0);
  const [preventionResult, setPreventionResult] = useState(null);
  const [preventionLoading, setPreventionLoading] = useState(false);
  const [preventionError, setPreventionError] = useState(null);
  const [breakdownResult, setBreakdownResult] = useState(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const activeToolRef = useRef(null);
  const planTypeRef = useRef('response');
  const startPointRef = useRef(null);
  const pendingCustomActionRef = useRef(null);
  const markersRef = useRef([]);
  const closedRoadsRef = useRef([]);
  useEffect(() => { markersRef.current = markers; }, [markers]);
  useEffect(() => { closedRoadsRef.current = closedRoads; }, [closedRoads]);
  const lastActionsRef = useRef([]);
  const beforeMapRef = useRef(null);
  const afterMapRef = useRef(null);
  const beforeMapContainer = useRef(null);
  const afterMapContainer = useRef(null);
  const breakdownMapRefs = useRef([]);
  const breakdownMapContainers = useRef([]);
  const breakdownAfterMapRefs = useRef([]);
  const breakdownAfterMapContainers = useRef([]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { planTypeRef.current = planType; }, [planType]);
  useEffect(() => { startPointRef.current = startPoint; }, [startPoint]);
  useEffect(() => { pendingCustomActionRef.current = pendingCustomAction; }, [pendingCustomAction]);

  // Stage 1: mount before/after comparison maps when preventionResult arrives
  useEffect(() => {
    if (!preventionResult) {
      if (beforeMapRef.current) { beforeMapRef.current.remove(); beforeMapRef.current = null; }
      if (afterMapRef.current) { afterMapRef.current.remove(); afterMapRef.current = null; }
      return;
    }
    if (!beforeMapContainer.current || !afterMapContainer.current) return;

    // Frame the thumbnail around the REAL flooded area, not just the
    // placed actions — zooming tightly to a small action cluster can crop
    // into one uniformly-flooded patch of a much larger flood and render
    // as a solid color block with no visible street detail (the image is
    // fine; only the camera was wrong). Widen that box to also include
    // every action's coordinates so placed markers stay in frame.
    var actions = lastActionsRef.current;
    var lons = [], lats = [];
    actions.forEach(function (a) {
      if (a.lat != null && a.lon != null) { lats.push(a.lat); lons.push(a.lon); }
      if (a.line_coords) { a.line_coords.forEach(function (c) { lons.push(c[0]); lats.push(c[1]); }); }
    });
    var pad = 0.005;
    var fb = preventionResult.flood_image_bounds;
    var floodedBbox = preventionResult.before && preventionResult.before.flooded_bbox;
    var w, s, e, n;
    if (floodedBbox) {
      w = floodedBbox[0]; s = floodedBbox[1]; e = floodedBbox[2]; n = floodedBbox[3];
    } else if (lons.length > 0) {
      w = Math.min.apply(null, lons) - pad;
      s = Math.min.apply(null, lats) - pad;
      e = Math.max.apply(null, lons) + pad;
      n = Math.max.apply(null, lats) + pad;
    } else {
      w = fb[0]; s = fb[1]; e = fb[2]; n = fb[3];
    }
    if (lons.length > 0) {
      w = Math.min(w, Math.min.apply(null, lons) - pad);
      s = Math.min(s, Math.min.apply(null, lats) - pad);
      e = Math.max(e, Math.max.apply(null, lons) + pad);
      n = Math.max(n, Math.max.apply(null, lats) + pad);
    }
    var fitBounds = [[w, s], [e, n]];
    var imgCoords = [[fb[0], fb[3]], [fb[2], fb[3]], [fb[2], fb[1]], [fb[0], fb[1]]];
    var baseStyle = {
      version: 8,
      sources: { 'osm': { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
      layers: [{ id: 'osm-layer', type: 'raster', source: 'osm' }],
    };

    function makeCompMap(container, imageB64) {
      if (!container) return null;
      var m = new maplibregl.Map({ container: container, style: JSON.parse(JSON.stringify(baseStyle)), bounds: fitBounds, fitBoundsOptions: { padding: 20 }, interactive: true });
      m.on('load', function () {
        m.addSource('flood-compare', { type: 'image', url: imageB64, coordinates: imgCoords });
        m.addLayer({ id: 'flood-compare-layer', type: 'raster', source: 'flood-compare', paint: { 'raster-opacity': 0.82 } });
      });
      return m;
    }

    if (beforeMapRef.current) { beforeMapRef.current.remove(); beforeMapRef.current = null; }
    if (afterMapRef.current) { afterMapRef.current.remove(); afterMapRef.current = null; }

    var bm = makeCompMap(beforeMapContainer.current, preventionResult.flood_image_before);
    var am = makeCompMap(afterMapContainer.current, preventionResult.flood_image_after);
    beforeMapRef.current = bm;
    afterMapRef.current = am;

    // Camera sync
    var syncing = false;
    if (bm && am) {
      bm.on('move', function () {
        if (syncing) return; syncing = true;
        am.jumpTo({ center: bm.getCenter(), zoom: bm.getZoom(), bearing: bm.getBearing(), pitch: bm.getPitch() });
        syncing = false;
      });
      am.on('move', function () {
        if (syncing) return; syncing = true;
        bm.jumpTo({ center: am.getCenter(), zoom: am.getZoom(), bearing: am.getBearing(), pitch: am.getPitch() });
        syncing = false;
      });
    }

    return function () {
      if (beforeMapRef.current) { beforeMapRef.current.remove(); beforeMapRef.current = null; }
      if (afterMapRef.current) { afterMapRef.current.remove(); afterMapRef.current = null; }
    };
    // showBreakdown is a real dependency, not just a lint requirement: the
    // container divs below are only rendered when `!showBreakdown`, so they
    // unmount/remount as it toggles. Without this, returning from the full
    // report re-creates the container DOM nodes but this effect never
    // re-runs (preventionResult hasn't changed), leaving the new nodes with
    // no maplibre map attached — a blank box with no error.
  }, [preventionResult, showBreakdown]);

  // Stage 2: mount per-action mini maps (before + after) when breakdown is shown
  useEffect(() => {
    if (!showBreakdown || !breakdownResult || !preventionResult) {
      breakdownMapRefs.current.forEach(function (m) { if (m) m.remove(); });
      breakdownMapRefs.current = [];
      breakdownAfterMapRefs.current.forEach(function (m) { if (m) m.remove(); });
      breakdownAfterMapRefs.current = [];
      return;
    }
    var rows = breakdownResult.per_action_breakdown || [];
    breakdownMapRefs.current.forEach(function (m) { if (m) m.remove(); });
    breakdownMapRefs.current = [];
    breakdownAfterMapRefs.current.forEach(function (m) { if (m) m.remove(); });
    breakdownAfterMapRefs.current = [];

    var fb = preventionResult.flood_image_bounds;
    var imgCoords = [[fb[0], fb[3]], [fb[2], fb[3]], [fb[2], fb[1]], [fb[0], fb[1]]];
    var baseStyle = {
      version: 8,
      sources: { 'osm': { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
      layers: [{ id: 'osm-layer', type: 'raster', source: 'osm' }],
    };

    // 500m in degrees (approximate at 33°N)
    var degPer500m = 0.0045;

    rows.forEach(function (row, i) {
      var lat = row.lat != null ? row.lat : (lastActionsRef.current[i] && lastActionsRef.current[i].lat);
      var lon = row.lon != null ? row.lon : (lastActionsRef.current[i] && lastActionsRef.current[i].lon);
      var fitBounds = (lat != null && lon != null)
        ? [[lon - degPer500m, lat - degPer500m], [lon + degPer500m, lat + degPer500m]]
        : [[fb[0], fb[1]], [fb[2], fb[3]]];

      var beforeContainer = breakdownMapContainers.current[i];
      if (beforeContainer) {
        var mb = new maplibregl.Map({ container: beforeContainer, style: JSON.parse(JSON.stringify(baseStyle)), bounds: fitBounds, fitBoundsOptions: { padding: 10 }, interactive: false });
        mb.on('load', function () {
          mb.addSource('flood-bd-b', { type: 'image', url: preventionResult.flood_image_before, coordinates: imgCoords });
          mb.addLayer({ id: 'flood-bd-b-layer', type: 'raster', source: 'flood-bd-b', paint: { 'raster-opacity': 0.78 } });
        });
        breakdownMapRefs.current[i] = mb;
      } else {
        breakdownMapRefs.current[i] = null;
      }

      var afterContainer = breakdownAfterMapContainers.current[i];
      if (afterContainer) {
        var ma = new maplibregl.Map({ container: afterContainer, style: JSON.parse(JSON.stringify(baseStyle)), bounds: fitBounds, fitBoundsOptions: { padding: 10 }, interactive: false });
        ma.on('load', function () {
          ma.addSource('flood-bd-a', { type: 'image', url: preventionResult.flood_image_after, coordinates: imgCoords });
          ma.addLayer({ id: 'flood-bd-a-layer', type: 'raster', source: 'flood-bd-a', paint: { 'raster-opacity': 0.78 } });
        });
        breakdownAfterMapRefs.current[i] = ma;
      } else {
        breakdownAfterMapRefs.current[i] = null;
      }
    });

    return function () {
      breakdownMapRefs.current.forEach(function (m) { if (m) m.remove(); });
      breakdownMapRefs.current = [];
      breakdownAfterMapRefs.current.forEach(function (m) { if (m) m.remove(); });
      breakdownAfterMapRefs.current = [];
    };
  }, [showBreakdown, breakdownResult]);

  var causeType = scenario && scenario.cause_type;
  const TOOLS = planType === 'response' ? RESPONSE_TOOLS : filterToolsByCauseType(PREVENTION_TOOLS, causeType);
  const responseRules = getResponseRules(scenario);

  // Single bundle of every data source a validator may need. Same idea as
  // the geoData object the prevention actions already pass around, just
  // extended with the layers and the live depth grid the response
  // actions need.
  // The roads this plan has closed, named to the backend by the graph
  // node ids roads.geojson carries. Closures whose road had no u/v are
  // dropped here and reported separately — a closure the router cannot be
  // told about must not silently look like one it honoured.
  function closedEdgesPayload() {
    return (closedRoadsRef.current || [])
      .filter(function (r) {
        return r.roadU !== undefined && r.roadU !== null && r.roadV !== undefined && r.roadV !== null;
      })
      .map(function (r) { return [r.roadU, r.roadV]; });
  }

  function buildGeoData() {
    return {
      scenario: scenario,
      diversionCheck: activeDiversionCheck,
      waterwaysGeoJSON: waterwaysDataRef.current,
      buildingsGeoJSON: buildingsDataRef.current,
      roadsGeoJSON: roadsDataRef.current,
      waterBodiesGeoJSON: waterBodiesDataRef.current,
      facilitiesGeoJSON: facilitiesDataRef.current,
      greeneryGeoJSON: greeneryDataRef.current,
      buildingPoints: buildingPointsRef.current,
      floodedRoadsGeoJSON: floodedRoadsFCRef.current,
      floodGrid: floodGridRef.current,
      closedRoads: closedRoadsRef.current,
      markers: markersRef.current,
    };
  }

  // A route drawn against one flood picture must never keep being shown
  // as "safe" once a different simulation exists. The plan page loads its
  // scenario once, so a re-run on the map page is only visible by
  // re-reading sessionStorage — done whenever this tab regains focus.
  useEffect(() => {
    if (!scenario) return;

    function checkDrift() {
      try {
        const raw = sessionStorage.getItem('mohafiz_scenario');
        if (!raw) return;
        const latest = JSON.parse(raw);
        if (latest.scenario_id && latest.scenario_id !== scenario.scenario_id) {
          setScenarioDrift({
            waterLevelM: latest.water_level_m,
            causeType: latest.cause_type,
          });
        }
      } catch (err) {
        // A drift check that cannot read is not evidence of no drift, but
        // it is also not evidence of drift — leave the flag alone.
      }
    }

    window.addEventListener('focus', checkDrift);
    document.addEventListener('visibilitychange', checkDrift);
    return function () {
      window.removeEventListener('focus', checkDrift);
      document.removeEventListener('visibilitychange', checkDrift);
    };
  }, [scenario]);

  // Pull the real depth of the water at every cell, for the water level
  // this simulation actually produced. Every response check reads this —
  // it is what makes "is this road impassable?" a measured question
  // rather than a guess off a flat blue overlay.
  useEffect(() => {
    if (!scenario) return;
    let cancelled = false;
    floodGridRef.current = null;

    fetch(API_URL + '/flood-depth-grid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ water_level_m: scenario.water_level_m }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (cancelled) return;
        if (!data || !data.depth_cm || !data.bounds) throw new Error('depth grid payload was empty');
        floodGridRef.current = data;
        setFloodGridStatus('ready');
      })
      .catch(function (err) {
        if (cancelled) return;
        console.error('flood depth grid failed', err);
        setFloodGridStatus('error');
      });

    return function () { cancelled = true; };
  }, [scenario]);

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
      setUncheckedHospitals([]);
      setRouteInfo(null);
      setDestinationPoint(null);
      setRouteGeo(null);
      setRouteAlertDismissed(false);

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
              closed_edges: closedEdgesPayload(),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status));
          return {
            name: h.name, lat: h.lat, lon: h.lon,
            reachable: data.reachable !== false,
            reason: data.unreachable_reason || null,
          };
        } catch (err) {
          // A check that FAILED is not a check that passed. Returning
          // "reachable" here would tell a crew a hospital is fine when
          // nothing actually confirmed it.
          return {
            name: h.name, lat: h.lat, lon: h.lon,
            reachable: null,
            error: String((err && err.message) || err),
          };
        }
      }));

      if (cancelled) return;

      setUnreachableHospitals(results.filter(function (r) { return r.reachable === false; }));
      setUncheckedHospitals(results.filter(function (r) { return r.reachable === null; }));
      setSweepClosureCount((closedRoadsRef.current || []).length);
      setCheckingAccess(false);
    }

    checkAll();
    return function () { cancelled = true; };
  }, [startPoint, scenario, accessCheckToken]);

  async function runRoute(destLat, destLon, destinationName) {
    const start = startPointRef.current;
    if (!start) {
      alert('Set a start point first — pick "Set start point" from the Routing panel, then click the map.');
      return;
    }

    setRouteInfo({ loading: true, hospitalName: destinationName });
    setRouteAlertDismissed(false);

    // The water level this route is calculated against, captured up front
    // so the drawn result can always be tied back to the simulation that
    // produced it.
    const routedWaterLevelM = scenario.water_level_m;
    const routedClosedEdges = closedEdgesPayload();

    try {
      const res = await fetch(API_URL + '/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: start.lat,
          start_lon: start.lon,
          end_lat: destLat,
          end_lon: destLon,
          water_level_m: routedWaterLevelM,
          closed_edges: routedClosedEdges,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Route failed');

      // Both routes are kept: the direct one shows what the flood costs,
      // the safe one shows what to actually drive. When nothing floods
      // they are the same path and the safe line simply sits on top.
      setRouteGeo({
        direct: data.direct_route && data.direct_route.length > 0 ? data.direct_route : null,
        safe: data.reachable && data.safe_route && data.safe_route.length > 0 ? data.safe_route : null,
        waterLevelM: routedWaterLevelM,
      });

      setDestinationPoint({ lat: destLat, lon: destLon, reachable: data.reachable });

      setRouteInfo({
        loading: false,
        hospitalName: destinationName,
        crossesFlood: data.crosses_flood,
        reachable: data.reachable,
        unreachableReason: data.unreachable_reason || null,
        directLengthM: data.direct_length_m,
        safeLengthM: data.safe_length_m,
        waterLevelM: routedWaterLevelM,
        crossesClosures: data.crosses_closures,
        safeCrossesClosures: data.safe_crosses_closures,
        closuresApplied: data.closures_applied,
        closuresAtRouteTime: (closedRoadsRef.current || []).length,
      });
    } catch (err) {
      // Never leave a stale line on the map next to a failed calculation.
      setRouteGeo(null);
      setDestinationPoint(null);
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
        // Kept index-aligned with buildings.features (nulls included) so
        // it can be used both for counting and as a geometry pre-filter.
        buildingPointsRef.current = buildings.features.map(featureCentroidLonLat);
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

      // Hospitals / schools / shelters — the same facilities layer the
      // map page draws. Response actions read it to flag hospitals inside
      // an evacuation zone (and, later, to snap shelters to real schools).
      try {
        const facilities = await (await fetch('/data/facilities.geojson')).json();
        facilitiesDataRef.current = facilities;
      } catch (err) {
        console.error('facilities.geojson failed (hospital/shelter checks will be skipped)', err);
      }

      // Green spaces — open ground for helicopter landing zones (Phase 3).
      try {
        const greenery = await (await fetch('/data/greenery.geojson')).json();
        greeneryDataRef.current = greenery;
      } catch (err) {
        console.error('greenery.geojson failed (open-space checks will be skipped)', err);
      }

      const roadFeatures = scenario.flooded_roads.map(function (coords, i) {
        return {
          type: 'Feature',
          properties: { roadIndex: i, closed: false },
          geometry: { type: 'LineString', coordinates: coords },
        };
      });

      floodedRoadsFCRef.current = { type: 'FeatureCollection', features: roadFeatures };

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

      map.addSource('evacuation-zones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'evacuation-zones-fill',
        type: 'fill',
        source: 'evacuation-zones',
        paint: {
          'fill-color': ['case', ['get', 'critical'], '#dc2626', '#7c3aed'],
          'fill-opacity': 0.14,
        },
      });
      map.addLayer({
        id: 'evacuation-zones-outline',
        type: 'line',
        source: 'evacuation-zones',
        paint: {
          'line-color': ['case', ['get', 'critical'], '#dc2626', '#7c3aed'],
          'line-width': 2.5,
          // Dashed so overlapping zone rings stay readable against each
          // other rather than merging into one solid blob.
          'line-dasharray': [3, 1.5],
        },
      });
      map.addLayer({
        id: 'evacuation-zones-label',
        type: 'symbol',
        source: 'evacuation-zones',
        layout: {
          'text-field': ['get', 'zoneLabel'],
          'text-size': 11,
          'text-offset': [0, -0.6],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['case', ['get', 'critical'], '#991b1b', '#5b21b6'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.5,
        },
      });

      map.addSource('warning-zones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'warning-zones-fill',
        type: 'fill',
        source: 'warning-zones',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.10 },
      });
      map.addLayer({
        id: 'warning-zones-outline',
        type: 'line',
        source: 'warning-zones',
        paint: {
          'line-color': '#f59e0b',
          'line-width': 2,
          // Dotted, so warning coverage never reads as an evacuation zone.
          'line-dasharray': [1, 2],
        },
      });
      map.addLayer({
        id: 'warning-zones-label',
        type: 'symbol',
        source: 'warning-zones',
        layout: {
          'text-field': ['get', 'zoneLabel'],
          'text-size': 10.5,
          'text-offset': [0, -0.6],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#92400e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.5,
        },
      });

      // Source only — no circle layer rendered from it. The persistent
      // emoji marker (see persistentMarkersRef below) is the single icon
      // per plan item; a colored circle layer used to render underneath
      // it too, which duplicated that icon with an unlabelled colour
      // swatch. The source stays so setData() below keeps working, but
      // nothing draws from it now.
      map.addSource('plan-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
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

      // DIRECT route — what you would drive if the flood did not exist.
      // Deliberately de-emphasised: thin, dashed and grey, so it can never
      // be mistaken for the route that is safe to take. Added first so the
      // safe route draws on top of it.
      map.addSource('route-direct', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-direct-outline',
        type: 'line',
        source: 'route-direct',
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.55 },
      });
      map.addLayer({
        id: 'route-direct-line',
        type: 'line',
        source: 'route-direct',
        paint: {
          'line-color': ['case', ['get', 'stale'], '#cbd5e1', '#64748b'],
          'line-width': 3.5,
          'line-dasharray': [2, 2],
        },
      });

      // FLOOD-SAFE route — the one a crew should actually drive. Solid,
      // thick and highlighted so it reads as the answer at a glance.
      // Greys right out when the route is stale.
      map.addSource('route-safe', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-safe-outline',
        type: 'line',
        source: 'route-safe',
        paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'route-safe-line',
        type: 'line',
        source: 'route-safe',
        paint: {
          'line-color': ['case', ['get', 'stale'], '#94a3b8', '#00c853'],
          'line-width': 6.5,
          'line-opacity': ['case', ['get', 'stale'], 0.55, 1],
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
          // ✕ = confirmed cut off. ? = the check itself failed, which is
          // NOT the same as "fine" and must not look like it.
          'text-field': ['case', ['==', ['get', 'status'], 'unchecked'], '?', '✕'],
          'text-size': 26,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'status'], 'unchecked'], '#b45309', '#000000'],
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

      // NOTE: closing a road used to happen right here, on a click on the
      // red flooded-roads layer, with no checks at all. It now goes
      // through resolvePlacement() like every other action, because the
      // red layer flags any road with water above 0m — including roads
      // under a few centimetres, which are still perfectly driveable.
      map.on('mouseenter', 'flooded-roads-hit', function () {
        if (activeToolRef.current === 'closeRoad') map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'flooded-roads-hit', function () {
        map.getCanvas().style.cursor = '';
      });

      map.on('click', function (ev) {
        const toolKey = activeToolRef.current;

        if (typeof window !== 'undefined' && window.__mohafizDebugMarkers) {
          // Temporary debug aid — compares the raw click pixel to the
          // lngLat maplibre resolved it to, so a mismatch between "where
          // I clicked" and "where the marker ends up" can be isolated to
          // either this click-to-coordinate step or the later render step.
          console.log('[click-debug]', {
            pixel: { x: ev.point.x, y: ev.point.y },
            lngLat: { lng: ev.lngLat.lng, lat: ev.lngLat.lat },
            devicePixelRatio: window.devicePixelRatio,
          });
        }

        if (toolKey === 'setStart') {
          setStartPoint({ lat: ev.lngLat.lat, lon: ev.lngLat.lng });
          return;
        }

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

          // A tool whose validation is not written yet must not silently
          // accept placements — the sidebar disables these, this is the
          // backstop.
          if (effectiveToolDef.implemented === false) {
            setToolError(effectiveToolDef.label + ' has no validation yet (Phase ' + effectiveToolDef.phase + '), so it cannot be placed — an unchecked placement would look verified when nothing verified it.');
            setTimeout(function () { setToolError(null); }, 4500);
            return;
          }

          const hasForm = effectiveToolDef.formFields !== undefined;
          const geoData = buildGeoData();

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

          // If this tool has form fields, open the parameter modal.
          // Response tools use the same modal — it is where the optional
          // duration / boat count / zone radius are entered, and where
          // the measured facts about the placement are shown before it
          // is committed.
          // Open the modal whenever there is something to enter OR something
          // measured worth confirming. A helipad has no fields but still has
          // facts (space name, clear radius) the operator should see before
          // it lands on the map.
          if (hasForm && (effectiveToolDef.formFields.length > 0 || effectiveToolDef.computeSummary)) {
            setPendingAction(Object.assign({ toolKey: effectiveToolDef.key, planType: planTypeRef.current }, result.payload));
            return;
          }

          // For removeEncroachment (empty formFields), confirm via modal
          if (hasForm && planTypeRef.current === 'prevention' && effectiveToolDef.formFields.length === 0) {
            setPendingAction(Object.assign({ toolKey: effectiveToolDef.key, planType: planTypeRef.current }, result.payload));
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('evacuation-zones');
    if (!src) return;

    const zones = markers.filter(function (m) {
      return m.type === 'evacuationZone' && m.params && Number(m.params.radiusM) > 0;
    });

    src.setData({
      type: 'FeatureCollection',
      features: zones.map(function (m, i) {
        const critical = !!(m.info && m.info.critical);
        const circle = turf.circle([m.lon, m.lat], Number(m.params.radiusM) / 1000, { steps: 64, units: 'kilometers' });
        circle.properties = {
          critical: critical,
          zoneLabel: 'Zone ' + (i + 1) + (critical ? ' · CRITICAL' : '') + ' · ' + Math.round(m.params.radiusM) + 'm',
        };
        return circle;
      }),
    });
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const src = map.getSource('warning-zones');
    if (!src) return;

    const zones = markers.filter(function (m) {
      return m.type === 'warningPoint' && m.params && Number(m.params.coverageRadiusM) > 0;
    });

    src.setData({
      type: 'FeatureCollection',
      features: zones.map(function (m, i) {
        const radiusM = Number(m.params.coverageRadiusM);
        const circle = turf.circle([m.lon, m.lat], radiusM / 1000, { steps: 64, units: 'kilometers' });
        circle.properties = {
          zoneLabel: 'Warning ' + (i + 1) + ' · ' + Math.round(radiusM) + 'm',
        };
        return circle;
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
        // 1.7x the old 20px — anchor stays 'center' below, which maplibre
        // implements as a CSS translate(-50%,-50%) on this element, so it
        // stays correctly centered on [m.lon, m.lat] at any font size.
        el.style.fontSize = '34px';
        el.style.lineHeight = '1';
        el.style.textAlign = 'center';
        el.style.pointerEvents = 'none';
        el.style.textShadow = '0 1px 4px rgba(0,0,0,0.5)';
        el.style.position = 'relative';
        el.textContent = m.emoji;

        // Same-type markers dropped on top of each other are fanned out
        // along a spiral and numbered, so the second never hides the
        // first. The offset is display-only — m.lat / m.lon stay exact.
        // Spread is scaled up to match the larger icon so two 34px emoji
        // don't still overlap the way two 20px ones would at the old radius.
        if (m.stackIndex) {
          const angle = (m.stackIndex * 137.5) * Math.PI / 180;
          const spread = 20 + m.stackIndex * 8;
          el.style.transform = 'translate(' + Math.round(Math.cos(angle) * spread) + 'px, ' +
            Math.round(Math.sin(angle) * spread) + 'px)';

          const badge = document.createElement('span');
          badge.textContent = String(m.stackIndex + 1);
          badge.style.position = 'absolute';
          badge.style.top = '-6px';
          badge.style.right = '-11px';
          badge.style.minWidth = '16px';
          badge.style.padding = '0 4px';
          badge.style.borderRadius = '8px';
          badge.style.background = m.color;
          badge.style.color = '#ffffff';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '800';
          badge.style.lineHeight = '16px';
          badge.style.textShadow = 'none';
          badge.style.boxShadow = '0 0 0 1.5px #ffffff';
          badge.style.fontFamily = 'system-ui, sans-serif';
          el.appendChild(badge);
        }

        current[m._uid] = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([m.lon, m.lat])
          .addTo(map);

        if (typeof window !== 'undefined' && window.__mohafizDebugMarkers) {
          // Temporary debug aid for the click-vs-render investigation —
          // compares the stored lon/lat against where maplibre actually
          // painted the element, in screen pixels, after layout settles.
          setTimeout(function () {
            var rect = el.getBoundingClientRect();
            var screenPt = map.project([m.lon, m.lat]);
            console.log('[marker-debug]', m.type, {
              storedLonLat: [m.lon, m.lat],
              mapProjectedPx: { x: screenPt.x, y: screenPt.y },
              renderedCenterPx: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
            });
          }, 0);
        }
      }
    });

    Object.keys(current).forEach(function (uid) {
      if (!activeUids[uid]) {
        current[uid].remove();
        delete current[uid];
      }
    });
  }, [markers]);

  // Every road closure gets a 🚧 at the exact point it was validated.
  // The red flooded-road line turning black only covers closures that
  // matched one of the simulation's own flagged roads — a road we closed
  // on measured depth alone would otherwise leave no mark at all.
  const closedRoadMarkersRef = useRef({});
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = closedRoadMarkersRef.current;
    const activeUids = {};

    closedRoads.forEach(function (r, i) {
      if (r.lat === undefined || r.lat === null) return;
      activeUids[r._uid] = true;
      if (!current[r._uid]) {
        const el = document.createElement('div');
        el.style.fontSize = '18px';
        el.style.lineHeight = '1';
        el.style.textAlign = 'center';
        el.style.pointerEvents = 'none';
        el.style.textShadow = '0 1px 4px rgba(0,0,0,0.5)';
        el.style.position = 'relative';
        el.textContent = '🚧';

        const badge = document.createElement('span');
        badge.textContent = String(i + 1);
        badge.style.position = 'absolute';
        badge.style.top = '-5px';
        badge.style.right = '-9px';
        badge.style.minWidth = '13px';
        badge.style.padding = '0 3px';
        badge.style.borderRadius = '7px';
        badge.style.background = '#dc2626';
        badge.style.color = '#ffffff';
        badge.style.fontSize = '9px';
        badge.style.fontWeight = '800';
        badge.style.lineHeight = '13px';
        badge.style.textShadow = 'none';
        badge.style.boxShadow = '0 0 0 1.5px #ffffff';
        badge.style.fontFamily = 'system-ui, sans-serif';
        el.appendChild(badge);

        current[r._uid] = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([r.lon, r.lat])
          .addTo(map);
      }
    });

    Object.keys(current).forEach(function (uid) {
      if (!activeUids[uid]) {
        current[uid].remove();
        delete current[uid];
      }
    });
  }, [closedRoads]);

  // A diversion's placement rule (near a closure) is answered instantly
  // from geometry, but whether it is on the RIGHT SIDE of that closure is
  // a road-network question — it needs the directed graph, one-ways and
  // all. So it runs while the confirm popup is open rather than blocking
  // the click, and the popup reports the verdict before anything lands.
  // Identity of the diversion currently awaiting confirmation. Stamped on
  // the result so an answer from a PREVIOUS popup can never be shown
  // against a different placement.
  const diversionCheckKey = (pendingAction && pendingAction.toolKey === 'diversion')
    ? [pendingAction.lat, pendingAction.lng, pendingAction.closureU, pendingAction.closureV].join('|')
    : null;

  useEffect(() => {
    if (!diversionCheckKey || !scenario || !pendingAction) return;
    let cancelled = false;

    fetch(API_URL + '/diversion-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diversion_lat: pendingAction.lat,
        diversion_lon: pendingAction.lng,
        closure_u: pendingAction.closureU,
        closure_v: pendingAction.closureV,
        water_level_m: scenario.water_level_m,
        closed_edges: closedEdgesPayload(),
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (cancelled) return;
        setDiversionCheck(Object.assign({ key: diversionCheckKey }, data));
      })
      .catch(function (err) {
        if (cancelled) return;
        setDiversionCheck({ key: diversionCheckKey, error: String((err && err.message) || err) });
      });

    return function () { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on diversionCheckKey, which already encodes every field of pendingAction this reads
  }, [diversionCheckKey, scenario]);

  // Until the answer for THIS placement arrives, the popup shows "checking",
  // never a leftover verdict from the last one.
  const activeDiversionCheck = diversionCheckKey
    ? ((diversionCheck && diversionCheck.key === diversionCheckKey) ? diversionCheck : { loading: true })
    : null;

  // A drawn route is stale the moment it no longer belongs to the
  // simulation on screen: either a different simulation now exists, or the
  // route was calculated at a different water level than the current one.
  const routeIsStale = !!routeGeo && (
    !!scenarioDrift ||
    (scenario ? routeGeo.waterLevelM !== scenario.water_level_m : false)
  );

  // Closures the router could NOT be told about — their road carried no
  // u/v identity — that the drawn safe route appears to run over.
  //
  // This proximity test is deliberately applied ONLY to those. For a
  // closure the router did receive, geometry cannot settle the question:
  // two distinct graph edges can share both endpoints and run alongside
  // each other (dual carriageways, service roads), so a route that
  // correctly avoids a closed edge can still pass within metres of it.
  // Whether the safe route honoured a named closure is answered by the
  // backend on the node path — see routeInfo.safeCrossesClosures.
  const routeClosureConflicts = (function () {
    if (!routeGeo || !routeGeo.safe || routeGeo.safe.length < 2) return [];
    const rules = getResponseRules(scenario);
    const limit = rules ? rules.CLOSURE_ON_ROUTE_M : 25;
    const line = turf.lineString(routeGeo.safe);
    return closedRoads.filter(function (r) {
      if (r.lat === undefined || r.lat === null) return false;
      const named = r.roadU !== undefined && r.roadU !== null && r.roadV !== undefined && r.roadV !== null;
      if (named) return false;
      return turf.nearestPointOnLine(line, turf.point([r.lon, r.lat]), { units: 'meters' })
        .properties.dist <= limit;
    });
  })();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource) return;
    const directSrc = map.getSource('route-direct');
    const safeSrc = map.getSource('route-safe');
    if (!directSrc || !safeSrc) return;

    function toFC(coords) {
      if (!coords || coords.length < 2) return { type: 'FeatureCollection', features: [] };
      return {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { stale: routeIsStale },
          geometry: { type: 'LineString', coordinates: coords },
        }],
      };
    }

    directSrc.setData(toFC(routeGeo && routeGeo.direct));
    safeSrc.setData(toFC(routeGeo && routeGeo.safe));
  }, [routeGeo, routeIsStale]);

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
        return { type: 'Feature', properties: { name: h.name, status: 'unreachable' }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } };
      }).concat(uncheckedHospitals.map(function (h) {
        return { type: 'Feature', properties: { name: h.name, status: 'unchecked' }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } };
      })),
    });
  }, [unreachableHospitals, uncheckedHospitals]);

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
    const toolDef = PREVENTION_TOOLS.find(function (t) { return t.key === toolKey; })
      || RESPONSE_TOOLS.find(function (t) { return t.key === toolKey; })
      || CUSTOM_ACTIONS.find(function (a) { return a.key === toolKey; });
    const forms = actionForms[toolKey] || {};

    // Validate number ranges for all fields
    var validationError = validateFormFields(forms, toolDef);
    if (validationError) {
      setToolError(validationError);
      return;
    }

    // Overlap detection for waterway actions
    var waterwayActions = ['desilt', 'clearDrains', 'widenChannel'];
    if (waterwayActions.indexOf(toolKey) >= 0 && pendingAction.targetWaterwayId) {
      var newLength = Number(forms.length || forms.sectionLength || 100);
      var existing = markers.filter(function(m) {
        return m.type === toolKey && m.planType === 'prevention' &&
               m.targetWaterwayId === pendingAction.targetWaterwayId;
      });
      for (var oi = 0; oi < existing.length; oi++) {
        var dist = turf.distance(
          turf.point([pendingAction.lng, pendingAction.lat]),
          turf.point([existing[oi].lon, existing[oi].lat]),
          { units: 'meters' }
        );
        var existingLen = Number((existing[oi].params && (existing[oi].params.length || existing[oi].params.sectionLength)) || 100);
        var threshold = (newLength + existingLen) * 0.5;
        if (dist < threshold) {
          setToolError('This overlaps an existing ' + toolDef.label.toLowerCase() + ' action ' + Math.round(dist) + 'm away — edit it instead.');
          return;
        }
      }
    }

    // Embankment overlap: check existing embankments for proximity
    if (toolKey === 'embankment') {
      var embCheckLen = Number(forms.length || 50);
      for (var ei = 0; ei < embankments.length; ei++) {
        var eDist = turf.distance(
          turf.point([pendingAction.lng, pendingAction.lat]),
          turf.point([embankments[ei].anchorLng, embankments[ei].anchorLat]),
          { units: 'meters' }
        );
        var eThreshold = (embCheckLen + embankments[ei].lengthM) * 0.5;
        if (eDist < eThreshold) {
          setToolError('This overlaps an existing embankment ' + Math.round(eDist) + 'm away — extend it instead.');
          return;
        }
      }
    }

    // Response actions have their own submit path — a road closure is
    // not a marker, and an evacuation zone has to compute what is inside
    // it before it is recorded.
    if (pendingAction.planType === 'response') {
      submitResponseAction(toolDef, forms);
      return;
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
          var dist = pointToFeatureDistance(clickPt, bFeatures[b]);
          if (dist < halfWidth) {
            setToolError('Widening to ' + newWidth + 'm needs ' + Math.round(halfWidth) + 'm clear on each side, but a building is ' + Math.round(dist) + 'm away.');
            return;
          }
        }
      }
    }

    // Retention pond: footprint check — does the pond radius overlap anything?
    if (toolKey === 'retentionPond') {
      var pondArea = Number(forms.area);
      if (pondArea) {
        var pondRadius = Math.sqrt(pondArea / Math.PI);
        var pondPt = turf.point([pendingAction.lng, pendingAction.lat]);

        try {
          if (buildingsDataRef.current) {
            var bFeatures = buildingsDataRef.current.features || [];
            for (var b = 0; b < bFeatures.length; b++) {
              var bg = bFeatures[b].geometry && bFeatures[b].geometry.type;
              var dist = pointToFeatureDistance(pondPt, bFeatures[b]);
              if (dist < pondRadius) {
                setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap a building ' + Math.round(dist) + 'm away.');
                return;
              }
            }
          }

          if (roadsDataRef.current && roadsDataRef.current.features) {
            var roadFeatures = roadsDataRef.current.features || [];
            for (var ri = 0; ri < roadFeatures.length; ri++) {
              var rGeom = roadFeatures[ri].geometry && roadFeatures[ri].geometry.type;
              if (rGeom !== 'LineString' && rGeom !== 'MultiLineString') continue;
              var rDist = pointToFeatureDistance(pondPt, roadFeatures[ri]);
              if (rDist < pondRadius) {
                setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap a road ' + Math.round(rDist) + 'm away.');
                return;
              }
            }
          }

          if (waterBodiesDataRef.current && waterBodiesDataRef.current.features) {
            for (var w = 0; w < waterBodiesDataRef.current.features.length; w++) {
              var wFeature = waterBodiesDataRef.current.features[w];
              var wGeom = wFeature.geometry && wFeature.geometry.type;
              if (wGeom !== 'Polygon' && wGeom !== 'MultiPolygon' && wGeom !== 'LineString') continue;
              var wDist = pointToFeatureDistance(pondPt, wFeature);
              if (wDist < pondRadius) {
                setToolError('A pond with ' + Math.round(pondArea) + ' m\u00B2 area (' + Math.round(pondRadius) + 'm radius) would overlap an existing water body ' + Math.round(wDist) + 'm away.');
                return;
              }
            }
          }
        } catch (pondErr) {
          console.error('Pond footprint check failed:', pondErr);
          setToolError('Could not verify pond placement — try a different location.');
          return;
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

  function submitResponseAction(toolDef, forms) {
    const geoData = buildGeoData();
    const rules = getResponseRules(scenario);

    // Closing a road is not a marker — it changes which roads the rest of
    // the plan can use, so it stays in closedRoads where it already was.
    if (toolDef.key === 'closeRoad') {
      const rawDuration = forms.durationHr;
      const durationHr = (rawDuration === undefined || rawDuration === null || String(rawDuration).trim() === '')
        ? null
        : Number(rawDuration);

      const roadUid = nextUid();
      const closure = {
        _uid: roadUid,
        planType: 'response',
        roadIndex: pendingAction.floodedRoadIndex,
        lat: pendingAction.lat,
        lon: pendingAction.lng,
        roadName: pendingAction.roadName,
        roadHighwayType: pendingAction.roadHighwayType,
        roadU: pendingAction.roadU,
        roadV: pendingAction.roadV,
        depthM: pendingAction.depthM,
        durationHr: durationHr,
      };
      setClosedRoads(function (prev) { return prev.concat([closure]); });
      setUndoStack(function (prev) { return prev.concat([{ type: 'closedRoad', uid: roadUid }]); });
      playInterventionAnimation(mapRef.current, 'closeRoad', pendingAction.lng, pendingAction.lat);
      setPendingAction(null);
      return;
    }

    // Everything else becomes a marker carrying the facts that were
    // actually measured at placement time.
    let info = null;
    if (toolDef.key === 'boatLaunch') {
      info = {
        depthM: pendingAction.depthM,
        maxDepthNearbyM: pendingAction.maxDepthNearbyM,
        atWaterEdge: pendingAction.atWaterEdge,
        waterDistanceM: pendingAction.waterDistanceM,
        roadName: pendingAction.roadName,
        roadHighwayType: pendingAction.roadHighwayType,
        roadDistanceM: pendingAction.roadDistanceM,
      };
    } else if (toolDef.key === 'evacuationZone') {
      info = computeEvacuationZoneStats(pendingAction.lat, pendingAction.lng, Number(forms.radiusM), scenario, geoData);
    } else if (toolDef.key === 'reliefCamp') {
      info = {
        nearestFloodM: pendingAction.nearestFloodM,
        snappedFacilityName: pendingAction.snappedFacilityName,
        snappedFacilityAmenity: pendingAction.snappedFacilityAmenity,
        snapDistanceM: pendingAction.snapDistanceM,
      };
    } else if (toolDef.key === 'medicalPost') {
      info = {
        nearestFloodM: pendingAction.nearestFloodM,
        nearestHospitalName: pendingAction.nearestHospitalName,
        nearestHospitalM: pendingAction.nearestHospitalM,
      };
    } else if (toolDef.key === 'supplyPoint') {
      info = {
        nearestFloodM: pendingAction.nearestFloodM,
        roadReachable: pendingAction.roadReachable,
        roadName: pendingAction.roadName,
        roadHighwayType: pendingAction.roadHighwayType,
        roadDistanceM: pendingAction.roadDistanceM,
      };
    } else if (toolDef.key === 'dewatering') {
      info = {
        depthM: pendingAction.depthM,
        clickDepthM: pendingAction.clickDepthM,
        movedToDeepestM: pendingAction.movedToDeepestM,
      };
    } else if (toolDef.key === 'helipad') {
      info = {
        spaceName: pendingAction.spaceName,
        clearRadiusM: pendingAction.clearRadiusM,
        nearestFloodM: pendingAction.nearestFloodM,
      };
    } else if (toolDef.key === 'diversion') {
      info = {
        onRoad: pendingAction.onRoad,
        roadName: pendingAction.roadName,
        roadHighwayType: pendingAction.roadHighwayType,
        closureDistanceM: pendingAction.closureDistanceM,
        divertingFrom: pendingAction.divertingFrom,
        selfFlooded: pendingAction.selfFlooded,
        selfFloodDepthM: pendingAction.selfFloodDepthM,
        // The road-network verdict as it stood when this was committed, so
        // the plan list shows what was actually known at the time.
        upstream: activeDiversionCheck && activeDiversionCheck.checked ? activeDiversionCheck.upstream : null,
        alternativeExists: activeDiversionCheck && activeDiversionCheck.checked ? activeDiversionCheck.alternative_exists : null,
      };
    } else if (toolDef.key === 'warningPoint') {
      info = Object.assign(
        computeWarningCoverage(pendingAction.lat, pendingAction.lng, Number(forms.coverageRadiusM), geoData),
        {
          snappedFacilityName: pendingAction.snappedFacilityName,
          snappedFacilityAmenity: pendingAction.snappedFacilityAmenity,
          snapDistanceM: pendingAction.snapDistanceM,
          selfFlooded: pendingAction.selfFlooded,
          selfFloodDepthM: pendingAction.selfFloodDepthM,
        }
      );
    }

    const params = {};
    if (toolDef.formFields) {
      toolDef.formFields.forEach(function (f) {
        const raw = forms[f.key];
        if (raw === undefined || raw === null || String(raw).trim() === '') return;
        params[f.key] = f.type === 'number' ? Number(raw) : raw;
      });
    }

    // Overlap is recorded, not blocked: two boat launches 15m apart can be
    // a real decision. What must not happen is the second one hiding the
    // first, so the renderer fans them out and numbers them.
    const overlapping = findNearbySameType(
      pendingAction.lat, pendingAction.lng, toolDef.key, markersRef.current, rules.SAME_TYPE_OVERLAP_M
    );

    const payload = Object.assign({}, pendingAction, {
      info: info,
      stackIndex: overlapping.length,
    });
    const marker = buildMarker(toolDef, payload, Object.keys(params).length > 0 ? params : null, 'response');

    setMarkers(function (prev) { return prev.concat([marker]); });
    setUndoStack(function (prev) { return prev.concat([{ type: 'marker', uid: marker._uid }]); });
    playInterventionAnimation(mapRef.current, toolDef.key, pendingAction.lng, pendingAction.lat);
    setPendingAction(null);

    if (overlapping.length > 0) {
      setToolNotice(
        'That is ' + (overlapping.length + 1) + ' × ' + toolDef.label.toLowerCase() +
        ' within ' + rules.SAME_TYPE_OVERLAP_M + 'm. They are numbered and offset on the map so you can tell them apart.'
      );
      setTimeout(function () { setToolNotice(null); }, 6000);
    }
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
    var currentPlanType = planType;
    setUndoStack(function (prev) {
      if (prev.length === 0) return prev;

      var targetIdx = -1;
      for (var i = prev.length - 1; i >= 0; i--) {
        var entry = prev[i];
        var match = false;
        switch (entry.type) {
          case 'marker':
            match = markers.some(function (m) { return m._uid === entry.uid && m.planType === currentPlanType; });
            break;
          case 'embankment':
            match = embankments.some(function (e) { return e._uid === entry.uid && e.planType === currentPlanType; });
            break;
          case 'closedRoad':
            match = closedRoads.some(function (r) { return r._uid === entry.uid && r.planType === currentPlanType; });
            break;
          case 'customNote':
            match = customNotes.some(function (n) { return n._uid === entry.uid && n.planType === currentPlanType; });
            break;
        }
        if (match) { targetIdx = i; break; }
      }
      if (targetIdx < 0) return prev;

      var target = prev[targetIdx];
      var targetUid = target.uid;
      switch (target.type) {
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
      return prev.slice(0, targetIdx).concat(prev.slice(targetIdx + 1));
    });
  }

  function clearAll() {
    setMarkers([]);
    setEmbankments([]);
    setClosedRoads([]);
    setCustomNotes([]);
    setUndoStack([]);
    setPreventionResult(null);
    setBreakdownResult(null);
    setShowBreakdown(false);
  }

  function buildPreventionActions() {
    var prevMarkers = markers.filter(function (m) { return m.planType === 'prevention'; });
    var prevEmbankments = embankments.filter(function (e) { return e.planType === 'prevention'; });
    var actions = [];
    prevMarkers.forEach(function (m) {
      actions.push({
        uid: m._uid,
        type: m.type,
        lat: m.lat,
        lon: m.lon,
        params: m.params || {},
        target_waterway_id: m.targetWaterwayId || null,
      });
    });
    prevEmbankments.forEach(function (e) {
      actions.push({
        uid: e._uid,
        type: 'embankment',
        lat: e.anchorLat,
        lon: e.anchorLng,
        params: { height: e.heightM, length: e.lengthM, material: e.material },
        line_coords: e.lineCoords,
      });
    });
    return actions;
  }

  async function runPreventionSim() {
    setPreventionLoading(true);
    setPreventionError(null);
    setPreventionResult(null);
    setBreakdownResult(null);
    setShowBreakdown(false);
    var scenarioParams = (scenario.params && scenario.params.params) ? scenario.params.params : {};
    var causeType = (scenario.params && scenario.params.cause_type) ? scenario.params.cause_type : scenario.cause_type;
    var actions = buildPreventionActions();
    lastActionsRef.current = actions;
    try {
      var res = await fetch(API_URL + '/prevention/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause_type: causeType,
          params: scenarioParams,
          water_level_m: scenario.water_level_m,
          actions: actions,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Simulation failed');
      setPreventionResult(data);
    } catch (err) {
      setPreventionError(err.message);
    } finally {
      setPreventionLoading(false);
    }
  }

  async function runPreventionBreakdown() {
    setBreakdownLoading(true);
    var scenarioParams = (scenario.params && scenario.params.params) ? scenario.params.params : {};
    var causeType = (scenario.params && scenario.params.cause_type) ? scenario.params.cause_type : scenario.cause_type;
    var actions = buildPreventionActions();
    try {
      var res = await fetch(API_URL + '/prevention/breakdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause_type: causeType,
          params: scenarioParams,
          water_level_m: scenario.water_level_m,
          actions: actions,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Breakdown failed');
      setBreakdownResult(data);
      setShowBreakdown(true);
    } catch (err) {
      setPreventionError(err.message);
    } finally {
      setBreakdownLoading(false);
    }
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

      {toolNotice && !toolError && (
        <div
          style={{
            position: 'absolute',
            top: 66,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: '#fefce8',
            border: '1px solid #fde68a',
            color: '#92400e',
            padding: '9px 18px',
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 700,
            boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            fontFamily: 'system-ui, sans-serif',
            maxWidth: 460,
            textAlign: 'center',
          }}
        >
          ℹ️ {toolNotice}
        </div>
      )}

      {(function () {
        // The route outcome that MUST NOT be missed: no safe route, a
        // failed calculation, or a route that no longer belongs to the
        // simulation on screen. Deliberately a large centre banner rather
        // than a line in the side panel.
        if (routeAlertDismissed) return null;

        let alert = null;
        if (routeInfo && routeInfo.error) {
          alert = {
            bg: '#7f1d1d', border: '#b91c1c',
            title: '⚠️ Route could not be calculated',
            body: routeInfo.error + ' — this is NOT a confirmation that the route is clear. Nothing was checked.',
          };
        } else if (routeInfo && !routeInfo.loading && routeInfo.reachable === false) {
          alert = {
            bg: '#991b1b', border: '#dc2626',
            title: '❌ No safe route currently exists to ' + routeInfo.hospitalName,
            body: routeInfo.unreachableReason === 'no_road_connection'
              ? 'There is no road connection between the start point and that location at all.'
              : 'Every road route to that location crosses water at the current level (' + routeInfo.waterLevelM + 'm). It is cut off.',
          };
        } else if (routeIsStale) {
          alert = {
            bg: '#92400e', border: '#f59e0b',
            title: '⚠️ This route is out of date',
            body: scenarioDrift
              ? 'The simulation has been re-run since this plan was opened (water level is now ' + scenarioDrift.waterLevelM + 'm, this route was calculated at ' + routeGeo.waterLevelM + 'm). The route drawn on the map is greyed out and must not be treated as safe. Re-open the Response Plan from the map to use the new simulation.'
              : 'This route was calculated at ' + routeGeo.waterLevelM + 'm, but the current simulation is at ' + scenario.water_level_m + 'm. Recalculate before using it.',
          };
        }
        if (!alert) return null;

        return (
          <div
            style={{
              position: 'absolute',
              top: (toolError || toolNotice) ? 116 : 66,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1001,
              background: alert.bg,
              border: '2px solid ' + alert.border,
              color: '#ffffff',
              padding: '12px 16px',
              borderRadius: 12,
              boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
              fontFamily: 'system-ui, sans-serif',
              maxWidth: 520,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>{alert.title}</div>
            <div style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.45, opacity: 0.95 }}>{alert.body}</div>
            <button
              onClick={function () { setRouteAlertDismissed(true); }}
              style={{
                marginTop: 8, padding: '4px 12px', borderRadius: 7,
                border: '1px solid rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.12)',
                color: '#ffffff', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        );
      })()}

      {pendingAction && (function () {
        const allTools = PREVENTION_TOOLS.concat(RESPONSE_TOOLS).concat(CUSTOM_ACTIONS).concat([CUSTOM_ACTION_TOOL]);
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

        // Response actions are checked against the live simulation, so
        // say which one — every number below is read from it, not from a
        // stored example. The summary recomputes as the fields change.
        var summaryLines = null;
        if (pendingAction.planType === 'response') {
          contextLine = 'Checked against the live ' + scenarioLabel(scenario) +
            ' simulation · water level ' + scenario.water_level_m + 'm';
          if (toolDef.computeSummary) {
            summaryLines = toolDef.computeSummary(pendingAction, forms, buildGeoData());
          }
        }

        const SUMMARY_TONES = {
          critical: { background: '#dc2626', color: '#ffffff' },
          bad: { background: '#fef2f2', color: '#b91c1c' },
          warn: { background: '#fefce8', color: '#92400e' },
          good: { background: '#f0fdf4', color: '#166534' },
        };

        let submitLabel = toolDef.submitLabel || 'Add to plan';
        // The check is advisory, not a veto — but committing against it
        // should never feel like the default path.
        const diversionDisagrees = pendingAction.toolKey === 'diversion' &&
          activeDiversionCheck && activeDiversionCheck.checked &&
          (activeDiversionCheck.upstream === false || activeDiversionCheck.alternative_exists === false);
        if (diversionDisagrees) submitLabel = 'Add anyway';
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

            {summaryLines && summaryLines.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {summaryLines.map(function (line, i) {
                  const tone = SUMMARY_TONES[line.tone] || { background: '#f8fafc', color: '#334155' };
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'baseline',
                        padding: '4px 7px',
                        marginBottom: 3,
                        borderRadius: 7,
                        background: tone.background,
                        color: tone.color,
                        fontSize: 10.5,
                        fontWeight: line.tone === 'critical' ? 800 : 600,
                      }}
                    >
                      <span style={{ opacity: 0.75, flexShrink: 0 }}>{line.label}</span>
                      <span style={{ marginLeft: 'auto', textAlign: 'right' }}>{line.value}</span>
                    </div>
                  );
                })}
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
                    {field.optional && <span style={{ fontWeight: 500, color: '#94a3b8' }}> — optional</span>}
                  </label>
                  <input
                    type="number"
                    value={forms[field.key] !== undefined ? forms[field.key] : field.default}
                    onChange={function (e) { updateField(field.key, e.target.value); }}
                    placeholder={field.optional ? 'leave blank if unknown' : undefined}
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
                style={{ flex: 2, padding: 8, borderRadius: 9, border: 'none', background: diversionDisagrees ? '#b45309' : toolDef.color, color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
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

        {planType === 'response' && (function () {
          let tone = null;
          if (!responseRules) {
            tone = {
              bg: '#fefce8', border: '#fde68a', color: '#92400e',
              text: '⚠️ Response actions are only validated for River Overflow so far. This is a ' +
                scenarioLabel(scenario) + ' simulation, which needs its own thresholds, so the actions are locked rather than checked against the wrong rules.',
            };
          } else if (floodGridStatus === 'loading') {
            tone = { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', text: '🔄 Loading the water depths for this simulation…' };
          } else if (floodGridStatus === 'error') {
            tone = {
              bg: '#fef2f2', border: '#fecaca', color: '#b91c1c',
              text: '❌ Could not load the water depths for this simulation — actions are locked, because without them nothing can be verified. Check the backend is running.',
            };
          } else {
            tone = {
              bg: '#f0fdf4', border: '#bbf7d0', color: '#166534',
              text: '✅ Checking against the live simulation — water level ' + scenario.water_level_m + 'm, depths sampled on a ' +
                Math.round(floodGridRef.current ? floodGridRef.current.cell_width_m : 0) + '×' +
                Math.round(floodGridRef.current ? floodGridRef.current.cell_height_m : 0) + 'm grid.',
            };
          }
          return (
            <div style={{ padding: 8, marginBottom: 9, borderRadius: 9, background: tone.bg, border: '1px solid ' + tone.border, color: tone.color, fontSize: 10.5, fontWeight: 600, lineHeight: 1.4 }}>
              {tone.text}
            </div>
          );
        })()}

        {TOOLS.map(function (tool) {
          const active = activeTool === tool.key;
          // A tool is locked when its validation is not written yet, when
          // the scenario has no rules, or while the depth data it checks
          // against has not loaded. Better a disabled button than one
          // that accepts an unverified placement.
          const notBuilt = tool.implemented === false;
          const locked = planType === 'response' && (notBuilt || !responseRules || floodGridStatus !== 'ready');
          return (
            <button
              key={tool.key}
              disabled={locked}
              title={notBuilt ? 'Phase ' + tool.phase + ' — validation not written yet' : tool.hint}
              onClick={function () { if (locked) return; setActiveTool(active ? null : tool.key); }}
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
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: locked ? 0.45 : 1,
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 16 }}>{tool.emoji}</span>
              <span style={{ flex: 1 }}>{tool.label}</span>
              {notBuilt && (
                <span style={{ fontSize: 9, fontWeight: 800, color: '#64748b', background: '#e2e8f0', borderRadius: 5, padding: '1px 5px' }}>
                  P{tool.phase}
                </span>
              )}
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
            <div>
              {unreachableHospitals.length > 0 && (
                <div style={{ marginTop: 6, padding: 8, borderRadius: 9, fontSize: 11, fontWeight: 600, background: '#fef2f2', color: '#dc2626' }}>
                  ❌ {unreachableHospitals.length} hospital{unreachableHospitals.length > 1 ? 's' : ''} unreachable — marked ✕ on map
                </div>
              )}
              {/* A hospital whose check FAILED is reported separately. It is
                  not reachable and not unreachable — it is unknown, and
                  folding it into "all reachable" would be a lie. */}
              {uncheckedHospitals.length > 0 && (
                <div style={{ marginTop: 6, padding: 8, borderRadius: 9, fontSize: 11, fontWeight: 600, background: '#fefce8', color: '#92400e' }}>
                  ⚠️ {uncheckedHospitals.length} hospital{uncheckedHospitals.length > 1 ? 's' : ''} could NOT be checked — marked ? on map. Treat as unknown, not clear.
                </div>
              )}
              {unreachableHospitals.length === 0 && uncheckedHospitals.length === 0 && (
                <div style={{ marginTop: 6, padding: 8, borderRadius: 9, fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#16a34a' }}>
                  ✅ All {hospitalCount} hospitals reachable at {scenario.water_level_m}m
                </div>
              )}
            </div>
          )}

          {routeGeo && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 9, background: '#f8fafc', fontSize: 10 }}>
              <div style={{ fontWeight: 700, color: '#334155', marginBottom: 4 }}>Route lines</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', marginBottom: 2 }}>
                <span style={{ width: 22, height: 0, borderTop: '3px dashed ' + (routeIsStale ? '#cbd5e1' : '#64748b'), flexShrink: 0 }} />
                direct route (ignores flooding)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b' }}>
                <span style={{ width: 22, height: 0, borderTop: '5px solid ' + (routeIsStale ? '#94a3b8' : '#00c853'), flexShrink: 0 }} />
                flood-safe route (drive this)
              </div>
            </div>
          )}

          {routeInfo && !routeInfo.loading && !routeInfo.error && (
            <div
              style={{
                marginTop: 8,
                padding: 9,
                borderRadius: 10,
                border: routeIsStale ? '2px solid #f59e0b' : 'none',
                background: routeIsStale ? '#fffbeb' : (routeInfo.reachable ? (routeInfo.crossesFlood ? '#fefce8' : '#f0fdf4') : '#fef2f2'),
                fontSize: 11,
              }}
            >
              <b>{routeInfo.hospitalName}</b>
              {routeIsStale && (
                <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 5, background: '#f59e0b', color: '#ffffff', fontSize: 9, fontWeight: 800 }}>
                  STALE
                </span>
              )}
              <div style={{ marginTop: 3 }}>
                {!routeInfo.crossesFlood && routeInfo.reachable && '✅ Direct route is clear (' + (routeInfo.directLengthM / 1000).toFixed(2) + ' km) — it is also the safe route'}
                {routeInfo.crossesFlood && routeInfo.reachable && '⚠️ Direct route floods — safe detour is ' + (routeInfo.safeLengthM / 1000).toFixed(2) + ' km (direct would be ' + (routeInfo.directLengthM / 1000).toFixed(2) + ' km)'}
                {!routeInfo.reachable && '❌ No safe route — that location is cut off by this flood'}
              </div>
              <div style={{ marginTop: 4, fontSize: 9.5, color: '#94a3b8' }}>
                calculated at water level {routeInfo.waterLevelM}m
              </div>
            </div>
          )}

          {routeInfo && !routeInfo.loading && !routeInfo.error && routeInfo.closuresApplied > 0 && !routeIsStale && (
            <div style={{ marginTop: 6, padding: 8, borderRadius: 9, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 10.5, fontWeight: 600 }}>
              🚧 Routed around {routeInfo.closuresApplied} road closure{routeInfo.closuresApplied > 1 ? 's' : ''} in this plan
              {routeInfo.crossesClosures ? ' (the direct route runs through one)' : ''}.
            </div>
          )}

          {/* Backstop. The router now excludes plan closures, so this can
              only fire for a closure whose road carried no u/v identity —
              exactly the case the router could not be told about. */}
          {routeClosureConflicts.length > 0 && !routeIsStale && (
            <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 10.5, fontWeight: 600 }}>
              ⚠️ This safe route may pass {routeClosureConflicts.length} closure{routeClosureConflicts.length > 1 ? 's' : ''} in your plan
              ({routeClosureConflicts.map(function (r) { return r.roadName || 'unnamed road'; }).join(', ')}).
              Those roads carry no routing identity, so the router could not be told to avoid them — re-check this route by hand.
            </div>
          )}

          {/* Should be unreachable: the router excludes every named closure
              before pathfinding. Shown anyway, because silently trusting an
              invariant is how a broken one goes unnoticed. */}
          {routeInfo && routeInfo.safeCrossesClosures && !routeIsStale && (
            <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: '#7f1d1d', color: '#ffffff', fontSize: 10.5, fontWeight: 700 }}>
              ⚠️ The router returned a safe route that runs over a closure it was told to avoid. Do not trust this route — please report it.
            </div>
          )}

          {startPoint && !checkingAccess && closedRoads.length !== sweepClosureCount && (
            <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: '#fefce8', border: '1px solid #fde68a', color: '#92400e', fontSize: 10.5, fontWeight: 600 }}>
              ⚠️ Roads have been closed since this access check ran, so the hospital results above are out of date.
              <button
                onClick={function () { setAccessCheckToken(function (t) { return t + 1; }); }}
                style={{ marginTop: 6, width: '100%', padding: '5px', borderRadius: 7, border: '1px solid #f59e0b', background: '#ffffff', color: '#92400e', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}
              >
                Re-check hospital access
              </button>
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
                    rainfall:         '\u201cUnblock the drain\u201d, \u201cBuild a water storage pond\u201d, \u201cRaise the road by 1m\u201d',
                    river_overflow:   '\u201cRaise a protective bank\u201d, \u201cClear the blocking structure\u201d, \u201cInstall a flood alert sensor\u201d',
                    drainage_failure: '\u201cDesilt the nullah\u201d, \u201cUnblock the drain\u201d, \u201cAdd a drainage channel\u201d',
                    dam_release:      '\u201cRaise protective banks\u201d, \u201cCreate flood storage\u201d, \u201cAdd a flood alert sensor\u201d',
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

        {planType === 'prevention' && (function () {
          var prevMarkerCount = markers.filter(function (m) { return m.planType === 'prevention'; }).length;
          var prevEmbCount = embankments.filter(function (e) { return e.planType === 'prevention'; }).length;
          var totalActions = prevMarkerCount + prevEmbCount;
          if (totalActions === 0 && !preventionResult) return null;
          return (
            <div style={{ marginTop: 10, borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
              <button
                onClick={runPreventionSim}
                disabled={preventionLoading}
                style={{
                  width: '100%',
                  padding: '9px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'linear-gradient(135deg, #0d9488, #0f766e)',
                  color: 'white',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  opacity: preventionLoading ? 0.7 : 1,
                }}
              >
                {preventionLoading ? 'Simulating...' : (preventionResult ? 'Re-run Prevention Impact' : 'Apply Prevention (' + totalActions + ' actions)')}
              </button>
              {preventionError && (
                <div style={{ marginTop: 6, fontSize: 10, color: '#dc2626', background: '#fef2f2', padding: 6, borderRadius: 6 }}>
                  {preventionError}
                </div>
              )}
            </div>
          );
        })()}
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
            {closedRoads.map(function (r, i) {
              return (
                <div key={r._uid || i} style={{ fontSize: 10, marginLeft: 20, marginTop: 4, padding: 6, background: '#f8fafc', borderRadius: 6 }}>
                  <div style={{ color: '#475569', fontWeight: 700 }}>
                    {r.roadName || (r.roadHighwayType ? String(r.roadHighwayType).replace(/_/g, ' ') : 'Road') + ' segment'}
                  </div>
                  <div style={{ color: '#b91c1c', fontWeight: 600 }}>
                    {r.depthM !== undefined ? formatDepth(r.depthM) + ' of water' : 'depth not recorded'}
                  </div>
                  {r.durationHr ? (
                    <div style={{ color: '#64748b' }}>expected {r.durationHr}h</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {currentEmbankments.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
            🧱 <b>{currentEmbankments.length}</b> × {(PREVENTION_TOOLS.find(function (t) { return t.key === 'embankment'; }) || {}).label || 'Raise Protective Bank'}
            {currentEmbankments.map(function (e, i) {
              return (
                <div key={i} style={{ fontSize: 10, marginLeft: 20, marginTop: 4, padding: 6, background: '#f8fafc', borderRadius: 6 }}>
                  <div style={{ color: '#475569', fontWeight: 600 }}>
                    {e.lengthM}m long, {e.heightM}m high, {e.material}
                  </div>
                  {e.difference ? (function () {
                    var impact = deriveImpact(e.before, e.after);
                    return (
                      <div style={{ marginTop: 3 }}>
                        <div style={{ color: impact.roadsSaved > 0 ? '#059669' : '#94a3b8', fontWeight: 700 }}>
                          {impact.roadsSaved > 0
                            ? '✅ ' + impact.roadsSaved + ' road' + (impact.roadsSaved !== 1 ? 's' : '') + ' saved'
                            : 'No roads affected'}
                        </div>
                        <div style={{ color: '#64748b' }}>
                          {impact.areaSavedM2 > 0 ? impact.areaSavedM2.toLocaleString() + ' m² protected' : 'No area change'}
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: 9 }}>
                          {e.before.flooded_percent}% → {e.after.flooded_percent}% flooded
                        </div>
                      </div>
                    );
                  })() : (
                    <div style={{ color: '#94a3b8' }}>Calculating impact...</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {planType === 'response' && RESPONSE_TOOLS.map(function (t) {
          const matching = currentMarkers.filter(function (m) { return m.type === t.key; });
          if (matching.length === 0) return null;
          return (
            <div key={t.key} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
              {t.emoji} <b>{matching.length}</b> × {t.label}
              {matching.map(function (m, i) {
                const info = m.info || {};
                const lines = [];

                if (t.key === 'boatLaunch') {
                  lines.push(info.atWaterEdge
                    ? 'water ' + Math.round(info.waterDistanceM) + 'm away, ' + formatDepth(info.maxDepthNearbyM) + ' deep'
                    : formatDepth(info.depthM) + ' of water at the point');
                  lines.push('road access ' + Math.round(info.roadDistanceM) + 'm' + (info.roadName ? ' (' + info.roadName + ')' : ''));
                  if (m.params && m.params.boatCount) lines.push(m.params.boatCount + ' boat' + (m.params.boatCount > 1 ? 's' : ''));
                } else if (t.key === 'evacuationZone') {
                  lines.push(Math.round(info.radiusM) + 'm radius · ' + info.buildingCount + ' buildings');
                  lines.push(info.maxDepthM > 0 ? 'max depth ' + formatDepth(info.maxDepthM) + ' · ' + info.floodedPercent + '% flooded' : 'no flooding inside this zone');
                } else if (t.key === 'reliefCamp') {
                  lines.push(info.snappedFacilityName
                    ? 'at ' + info.snappedFacilityName + ' (' + amenityLabel(info.snappedFacilityAmenity) + ')'
                    : 'on open ground');
                  if (m.params && m.params.capacity) lines.push('capacity ' + m.params.capacity + ' people');
                  lines.push(floodClearanceText(info.nearestFloodM));
                } else if (t.key === 'medicalPost') {
                  if (m.params && m.params.postType) {
                    const opt = t.formFields[0].options.find(function (o) { return o.value === m.params.postType; });
                    lines.push(opt ? opt.label : m.params.postType);
                  }
                  if (m.params && m.params.capacity) lines.push('capacity ' + m.params.capacity + ' patients');
                  lines.push(info.nearestHospitalM !== null && info.nearestHospitalM !== undefined
                    ? 'nearest hospital ' + (info.nearestHospitalM >= 1000
                        ? (info.nearestHospitalM / 1000).toFixed(1) + 'km'
                        : Math.round(info.nearestHospitalM) + 'm') + ' away'
                    : 'no hospital found nearby');
                  lines.push(floodClearanceText(info.nearestFloodM));
                } else if (t.key === 'dewatering') {
                  lines.push(formatDepth(info.depthM) + ' of water at the pump');
                  if (info.movedToDeepestM > 5) lines.push('moved ' + Math.round(info.movedToDeepestM) + 'm to the deepest point');
                  if (m.params && m.params.capacityLps) lines.push(m.params.capacityLps + ' L/s');
                } else if (t.key === 'helipad') {
                  lines.push('on ' + info.spaceName);
                  lines.push(info.clearRadiusM + 'm clear radius · dry ground');
                } else if (t.key === 'diversion') {
                  lines.push('diverting from ' + info.divertingFrom + ' (' + Math.round(info.closureDistanceM) + 'm)');
                  if (!info.onRoad) lines.push('\u26A0 not on a mapped road');
                  if (info.upstream === false) lines.push('\u26A0 not upstream of that closure');
                  if (info.alternativeExists === false) lines.push('\u26A0 no way round from here');
                  if (info.upstream === true && info.alternativeExists === true) lines.push('\u2713 upstream, with a way round');
                  if (info.selfFlooded) lines.push('\u26A0 point itself under ' + formatDepth(info.selfFloodDepthM));
                } else if (t.key === 'warningPoint') {
                  lines.push(Math.round(info.radiusM) + 'm coverage · ' + info.buildingCount + ' buildings');
                  lines.push('\u2248 ' + info.estimatedPeople + ' people (rough estimate)');
                  if (info.snappedFacilityName) lines.push('at ' + info.snappedFacilityName);
                  if (info.selfFlooded) lines.push('\u26A0 point itself under ' + formatDepth(info.selfFloodDepthM));
                } else if (t.key === 'supplyPoint') {
                  if (m.params && m.params.supplyCapacity) lines.push(m.params.supplyCapacity + ' people/day');
                  lines.push(info.roadDistanceM === null || info.roadDistanceM === undefined
                    ? 'road access unverified'
                    : info.roadReachable
                      ? 'road access ' + Math.round(info.roadDistanceM) + 'm'
                      : '⚠ no road within ' + Math.round(info.roadDistanceM) + 'm');
                  lines.push(floodClearanceText(info.nearestFloodM));
                }

                return (
                  <div key={m._uid} style={{ fontSize: 10, marginLeft: 20, marginTop: 4, padding: 6, background: info.critical ? '#fef2f2' : '#f8fafc', borderRadius: 6 }}>
                    <div style={{ color: '#475569', fontWeight: 700 }}>
                      #{i + 1}{m.stackIndex ? ' (overlaps an earlier one)' : ''}
                    </div>
                    {info.critical && (
                      <div style={{ color: '#b91c1c', fontWeight: 800 }}>
                        🚨 CRITICAL — hospital inside: {info.hospitals.join(', ')}
                      </div>
                    )}
                    {lines.map(function (line, li) {
                      return <div key={li} style={{ color: '#64748b' }}>{line}</div>;
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}

        {planType === 'prevention' && TOOLS.filter(function (t) { return t.kind === 'point'; }).map(function (t) {
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

      {preventionResult && !showBreakdown && (
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 1001,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={function () { setPreventionResult(null); setPreventionError(null); }}
        >
          <div
            onClick={function (e) { e.stopPropagation(); }}
            style={{
              background: 'white',
              borderRadius: 20,
              padding: 24,
              maxWidth: 780,
              width: '90vw',
              maxHeight: '85vh',
              overflowY: 'auto',
              fontFamily: 'system-ui, sans-serif',
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>
                🛡️ Prevention Impact Report
              </div>
              <button
                onClick={function () { setPreventionResult(null); setPreventionError(null); }}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>Before (no prevention)</div>
                <div ref={beforeMapContainer} style={{ width: '100%', height: 200, borderRadius: 10, border: '1px solid #fecaca', marginBottom: 8, overflow: 'hidden' }} />
                <div style={{ fontSize: 11, color: '#334155' }}>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.before.flooded_percent}%</b> area flooded</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.before.roads_cut}</b> roads cut</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.before.buildings_affected}</b> buildings affected</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.before.avg_depth_m}m</b> avg depth</div>
                  <div><b>{preventionResult.before.max_depth_m}m</b> max depth</div>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#059669', marginBottom: 8 }}>After (with prevention)</div>
                <div ref={afterMapContainer} style={{ width: '100%', height: 200, borderRadius: 10, border: '1px solid #bbf7d0', marginBottom: 8, overflow: 'hidden' }} />
                <div style={{ fontSize: 11, color: '#334155' }}>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.after.flooded_percent}%</b> area flooded</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.after.roads_cut}</b> roads cut</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.after.buildings_affected}</b> buildings affected</div>
                  <div style={{ marginBottom: 3 }}><b>{preventionResult.after.avg_depth_m}m</b> avg depth</div>
                  <div><b>{preventionResult.after.max_depth_m}m</b> max depth</div>
                </div>
              </div>
            </div>

            {(function () {
              var impact = deriveImpact(preventionResult.before, preventionResult.after);
              var goodColor = '#059669';
              var flatColor = '#94a3b8';
              if (!impact.hasMeasurableEffect) {
                return (
                  <div style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    padding: 12,
                    textAlign: 'center',
                    fontSize: 12,
                    color: '#64748b',
                    marginBottom: 8,
                  }}>
                    No measurable improvement at this scale — the flood extent, roads and buildings are unchanged.
                  </div>
                );
              }
              return (
                <div style={{
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: 12,
                  padding: 12,
                  display: 'flex',
                  gap: 20,
                  justifyContent: 'center',
                  fontSize: 12,
                  marginBottom: 8,
                }}>
                  <div>
                    <span style={{ color: impact.floodedPercentChange > 0 ? goodColor : flatColor, fontWeight: 800 }}>
                      {impact.floodedPercentChange}%
                    </span>
                    <span style={{ color: '#64748b', marginLeft: 4 }}>less flood area</span>
                  </div>
                  <div>
                    <span style={{ color: impact.areaSavedM2 > 0 ? goodColor : flatColor, fontWeight: 800 }}>
                      {impact.areaSavedM2.toLocaleString()} m²
                    </span>
                    <span style={{ color: '#64748b', marginLeft: 4 }}>area saved</span>
                  </div>
                  <div>
                    <span style={{ color: impact.roadsSaved > 0 ? goodColor : flatColor, fontWeight: 800 }}>
                      {impact.roadsSaved}
                    </span>
                    <span style={{ color: '#64748b', marginLeft: 4 }}>roads saved</span>
                  </div>
                  <div>
                    <span style={{ color: impact.buildingsSaved > 0 ? goodColor : flatColor, fontWeight: 800 }}>
                      {impact.buildingsSaved}
                    </span>
                    <span style={{ color: '#64748b', marginLeft: 4 }}>buildings protected</span>
                  </div>
                </div>
              );
            })()}

            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 12, padding: '0 4px', display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: '#2563eb', display: 'inline-block' }} /> still flooded
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: '#10b981', display: 'inline-block' }} /> protected by this plan
              </span>
            </div>

            {(preventionResult.difference.water_level_saved_m > 0 || preventionResult.difference.volume_stored_m3 > 0) && (
              <div style={{
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 12,
                padding: '10px 14px',
                fontSize: 11,
                color: '#1e40af',
                marginBottom: 14,
                display: 'flex',
                gap: 16,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 13 }}>💧</span>
                <div>
                  {preventionResult.difference.water_level_saved_m > 0 ? (
                    <>
                      <span style={{ fontWeight: 800 }}>Water level lowered by {preventionResult.difference.water_level_saved_m}m</span>
                      <span style={{ color: '#3b82f6', marginLeft: 6 }}>—</span>
                      <span style={{ marginLeft: 6 }}>
                        <span style={{ fontWeight: 700 }}>{Number(preventionResult.difference.volume_stored_m3).toLocaleString()} m³</span> intercepted before it reaches the floodplain
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontWeight: 800 }}>{Number(preventionResult.difference.volume_stored_m3).toLocaleString()} m³ intercepted locally</span>
                      <span style={{ color: '#3b82f6', marginLeft: 6 }}>—</span>
                      <span style={{ marginLeft: 6 }}>
                        a single measure can&apos;t lower this river&apos;s overall flood stage, but it protects the ground around it (see green area above)
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            {preventionResult.capacity && preventionResult.capacity.applies_to_cause && (
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, padding: '0 4px' }}>
                Runoff coefficient: {preventionResult.capacity.runoff_coefficient_before || 0.6} → <b>{preventionResult.capacity.runoff_coefficient_after}</b>
                {preventionResult.capacity.total_treated_length_m > 0 && (
                  <span> ({Math.round(preventionResult.capacity.total_treated_length_m)}m of waterway treated)</span>
                )}
              </div>
            )}

            {preventionResult.terrain_meta && preventionResult.terrain_meta.pixels_raised > 0 && (
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, padding: '0 4px' }}>
                Terrain modified: {preventionResult.terrain_meta.pixels_raised} pixels raised, {preventionResult.terrain_meta.pixels_lowered} pixels lowered
                {preventionResult.terrain_meta.subpixel_actions && preventionResult.terrain_meta.subpixel_actions.length > 0 && (
                  <span> ({preventionResult.terrain_meta.subpixel_actions.length} sub-pixel actions scaled proportionally)</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={runPreventionBreakdown}
                disabled={breakdownLoading}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#0d9488',
                  color: 'white',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  opacity: breakdownLoading ? 0.7 : 1,
                }}
              >
                {breakdownLoading ? 'Computing breakdown...' : 'See full impact report →'}
              </button>
              <button
                onClick={function () { setPreventionResult(null); }}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  background: '#f8fafc',
                  color: '#475569',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showBreakdown && breakdownResult && (
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 1002,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={function () { setShowBreakdown(false); }}
        >
          <div
            onClick={function (e) { e.stopPropagation(); }}
            style={{
              background: 'white',
              borderRadius: 20,
              padding: 24,
              maxWidth: 760,
              width: '92vw',
              maxHeight: '88vh',
              overflowY: 'auto',
              fontFamily: 'system-ui, sans-serif',
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>Full Impact Report</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Combined effect of all {(breakdownResult.per_action_breakdown || []).length} prevention actions</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={function () { setShowBreakdown(false); }}
                  style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 12px', fontSize: 11, cursor: 'pointer', color: '#475569', fontWeight: 600 }}
                >
                  ← Summary
                </button>
                <button
                  onClick={function () { setShowBreakdown(false); setPreventionResult(null); }}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Total effect banner — every number here is already clamped
                server-side (max(0, before - after)), so 0 always means
                "no measurable improvement", never a hidden negative. */}
            {(function () {
              var te = breakdownResult.total_effect || {};
              var flat = { bg: 'linear-gradient(135deg, #f8fafc, #f1f5f9)', border: '#e2e8f0', text: '#94a3b8', label: '#64748b' };
              var pctStyle = te.flooded_percent_change > 0 ? { bg: 'linear-gradient(135deg, #ecfdf5, #d1fae5)', border: '#a7f3d0', text: '#059669', label: '#065f46' } : flat;
              var areaStyle = te.area_saved_m2 > 0 ? { bg: 'linear-gradient(135deg, #ecfdf5, #d1fae5)', border: '#a7f3d0', text: '#059669', label: '#065f46' } : flat;
              var roadsStyle = te.roads_saved > 0 ? { bg: 'linear-gradient(135deg, #eff6ff, #dbeafe)', border: '#93c5fd', text: '#2563eb', label: '#1e3a8a' } : flat;
              var bldgStyle = te.buildings_saved > 0 ? { bg: 'linear-gradient(135deg, #fdf4ff, #f3e8ff)', border: '#d8b4fe', text: '#7c3aed', label: '#4c1d95' } : flat;
              var hasEffect = te.flooded_percent_change > 0 || te.area_saved_m2 > 0 || te.roads_saved > 0 || te.buildings_saved > 0;
              return (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: hasEffect ? 16 : 8 }}>
                    <div style={{ flex: 1, background: pctStyle.bg, borderRadius: 14, padding: '14px 16px', textAlign: 'center', border: '1px solid ' + pctStyle.border }}>
                      <div style={{ fontSize: 28, fontWeight: 900, color: pctStyle.text, lineHeight: 1 }}>
                        {te.flooded_percent_change || 0}%
                      </div>
                      <div style={{ fontSize: 10, color: pctStyle.label, fontWeight: 700, marginTop: 4 }}>Flood Area Reduction</div>
                    </div>
                    <div style={{ flex: 1, background: areaStyle.bg, borderRadius: 14, padding: '14px 16px', textAlign: 'center', border: '1px solid ' + areaStyle.border }}>
                      <div style={{ fontSize: 22, fontWeight: 900, color: areaStyle.text, lineHeight: 1 }}>
                        {Number(te.area_saved_m2 || 0).toLocaleString()}
                      </div>
                      <div style={{ fontSize: 10, color: areaStyle.label, fontWeight: 700, marginTop: 4 }}>m² Area Saved</div>
                    </div>
                    <div style={{ flex: 1, background: roadsStyle.bg, borderRadius: 14, padding: '14px 16px', textAlign: 'center', border: '1px solid ' + roadsStyle.border }}>
                      <div style={{ fontSize: 28, fontWeight: 900, color: roadsStyle.text, lineHeight: 1 }}>
                        {te.roads_saved || 0}
                      </div>
                      <div style={{ fontSize: 10, color: roadsStyle.label, fontWeight: 700, marginTop: 4 }}>Roads Protected</div>
                    </div>
                    <div style={{ flex: 1, background: bldgStyle.bg, borderRadius: 14, padding: '14px 16px', textAlign: 'center', border: '1px solid ' + bldgStyle.border }}>
                      <div style={{ fontSize: 28, fontWeight: 900, color: bldgStyle.text, lineHeight: 1 }}>
                        {te.buildings_saved || 0}
                      </div>
                      <div style={{ fontSize: 10, color: bldgStyle.label, fontWeight: 700, marginTop: 4 }}>Buildings Protected</div>
                    </div>
                  </div>
                  {!hasEffect && (
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 16, padding: '0 4px' }}>
                      No measurable improvement at this scale — the combined plan doesn&apos;t change flood extent, roads or buildings.
                    </div>
                  )}
                </>
              );
            })()}

            {/* Physics impact row */}
            {breakdownResult.total_effect && (breakdownResult.total_effect.water_level_saved_m > 0 || breakdownResult.total_effect.volume_stored_m3 > 0) && (
              <div style={{
                background: 'linear-gradient(135deg, #eff6ff, #dbeafe)',
                border: '1px solid #93c5fd',
                borderRadius: 14,
                padding: '12px 16px',
                marginBottom: 16,
                display: 'flex',
                gap: 24,
                alignItems: 'center',
              }}>
                <div style={{ textAlign: 'center', flex: 1 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#1d4ed8', lineHeight: 1 }}>
                    {breakdownResult.total_effect.water_level_saved_m > 0
                      ? breakdownResult.total_effect.water_level_saved_m + 'm'
                      : Number(breakdownResult.total_effect.locally_protected_m3 || 0).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: '#1e3a8a', fontWeight: 700, marginTop: 4 }}>
                    {breakdownResult.total_effect.water_level_saved_m > 0 ? 'Water Level Lowered' : 'm³ Protecting Local Area'}
                  </div>
                </div>
                <div style={{ width: 1, height: 36, background: '#bfdbfe' }} />
                <div style={{ textAlign: 'center', flex: 1 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#1d4ed8', lineHeight: 1 }}>
                    {Number(breakdownResult.total_effect.volume_stored_m3).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: '#1e3a8a', fontWeight: 700, marginTop: 4 }}>m³ Volume Intercepted</div>
                </div>
              </div>
            )}

            {/* Interaction note */}
            {breakdownResult.interaction_note && (
              <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '8px 12px', fontSize: 10, color: '#92400e', marginBottom: 16 }}>
                ℹ {breakdownResult.interaction_note}
              </div>
            )}

            {/* Per-action section header */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>Individual Action Impact</div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 12 }}>
              Each row shows the marginal contribution of that action (leave-one-out method). Maps are zoomed to a fixed 500m radius around each action site.
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={{ padding: '6px 4px', color: '#475569', fontWeight: 700 }}>Action</th>
                  <th style={{ padding: '6px 4px', color: '#475569', fontWeight: 700 }}>Tier</th>
                  <th style={{ padding: '6px 4px', color: '#475569', fontWeight: 700, textAlign: 'right' }}>Flood %</th>
                  <th style={{ padding: '6px 4px', color: '#475569', fontWeight: 700, textAlign: 'right' }}>Roads</th>
                  <th style={{ padding: '6px 4px', color: '#475569', fontWeight: 700, textAlign: 'right' }}>Buildings</th>
                </tr>
              </thead>
              <tbody>
                {breakdownResult.per_action_breakdown && breakdownResult.per_action_breakdown.map(function (row, i) {
                  var typeLabel = row.type;
                  var allTools = PREVENTION_TOOLS.concat(CUSTOM_ACTIONS);
                  var toolDef = allTools.find(function (t) { return t.key === row.type; });
                  if (toolDef) typeLabel = toolDef.emoji + ' ' + toolDef.label;
                  var tierColor = row.honesty_tier === 'Simulated' ? '#059669' :
                    row.honesty_tier.indexOf('simplified') >= 0 ? '#d97706' :
                    row.honesty_tier.indexOf('Preparedness') >= 0 ? '#6366f1' : '#0d9488';
                  return [
                    <tr key={'map-' + i} style={{ borderBottom: 'none' }}>
                      <td colSpan={5} style={{ padding: '8px 4px 0' }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3, fontWeight: 600 }}>Before</div>
                            <div
                              ref={function (el) { breakdownMapContainers.current[i] = el; }}
                              style={{ width: '100%', height: 120, borderRadius: 6, border: '1px solid #fecaca', overflow: 'hidden' }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3, fontWeight: 600 }}>After</div>
                            <div
                              ref={function (el) { breakdownAfterMapContainers.current[i] = el; }}
                              style={{ width: '100%', height: 120, borderRadius: 6, border: '1px solid #bbf7d0', overflow: 'hidden' }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>,
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 4px' }}>
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{typeLabel}</div>
                        {row.note && (
                          <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2 }}>{row.note}</div>
                        )}
                        {row.is_subpixel && (
                          <div style={{ fontSize: 9, color: '#d97706', marginTop: 2 }}>Sub-pixel — effect scaled</div>
                        )}
                        {row.volume_stored_m3 > 0 && (
                          <div style={{ fontSize: 9, color: '#2563eb', marginTop: 2 }}>
                            💧 {Number(row.volume_stored_m3).toLocaleString()} m³ intercepted
                            {row.water_level_saved_m > 0
                              ? ' · ' + row.water_level_saved_m + 'm water level drop'
                              : row.area_saved_m2 > 0
                                ? ' · ' + Number(row.area_saved_m2).toLocaleString() + ' m² protected locally'
                                : ' · protects its immediate surroundings, not the whole river stage'}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px 4px' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 6px',
                          borderRadius: 6,
                          background: tierColor + '15',
                          color: tierColor,
                          fontSize: 9,
                          fontWeight: 700,
                        }}>
                          {row.honesty_tier}
                        </span>
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: 600, color: formatFloodPctDelta(row.delta_flooded_percent).color }}>
                        {formatFloodPctDelta(row.delta_flooded_percent).text}
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: 600, color: row.roads_saved > 0 ? '#059669' : '#94a3b8' }}>
                        {row.roads_saved > 0 ? row.roads_saved : '—'}
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: 600, color: row.buildings_saved > 0 ? '#059669' : '#94a3b8' }}>
                        {row.buildings_saved > 0 ? row.buildings_saved : '—'}
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e2e8f0', fontWeight: 800 }}>
                  <td style={{ padding: '8px 4px', color: '#0f172a' }}>Combined Total</td>
                  <td></td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', color: formatFloodPctDelta((breakdownResult.total_effect && breakdownResult.total_effect.flooded_percent_change) || 0).color }}>
                    {formatFloodPctDelta((breakdownResult.total_effect && breakdownResult.total_effect.flooded_percent_change) || 0).text}
                  </td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', color: (breakdownResult.total_effect && breakdownResult.total_effect.roads_saved) > 0 ? '#059669' : '#94a3b8' }}>
                    {(breakdownResult.total_effect && breakdownResult.total_effect.roads_saved) || 0}
                  </td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', color: (breakdownResult.total_effect && breakdownResult.total_effect.buildings_saved) > 0 ? '#059669' : '#94a3b8' }}>
                    {(breakdownResult.total_effect && breakdownResult.total_effect.buildings_saved) || 0}
                  </td>
                </tr>
              </tfoot>
            </table>

            {/* Overlap note */}
            {breakdownResult.sum_of_marginals && Math.abs(breakdownResult.sum_of_marginals.flooded_percent_change - ((breakdownResult.total_effect && breakdownResult.total_effect.flooded_percent_change) || 0)) > 0.5 && (
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 10, padding: '6px 10px', background: '#f8fafc', borderRadius: 8 }}>
                Sum of individual effects: {breakdownResult.sum_of_marginals.flooded_percent_change}% — actions overlap in coverage so combined total is less than the sum of parts. This is correct behaviour.
              </div>
            )}
          </div>
        </div>
      )}

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}