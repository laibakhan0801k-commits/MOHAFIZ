'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

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
    emoji: '🪣',
    color: '#0891b2',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line where silt needs removing — clicks off the waterway are rejected',
    effect: { drainage_capacity_gain_pct: 15 },
    effectLabel: '+15% channel capacity (estimate)',
    realBasis: 'Real precedent: in 2020, govt approved Rs40M specifically to desilt Nullah Leh + 10 other nullahs. Officials predicted a 12ft water-level rise if it did NOT happen.',
  },
  {
    key: 'clearDrains',
    label: 'Clear blocked drains',
    emoji: '🕳️',
    color: '#f59e0b',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line near the blocked section — clicks off the waterway are rejected',
    effect: { drainage_capacity_gain_pct: 10 },
    effectLabel: '+10% drainage capacity (estimate)',
    realBasis: 'Real context: local drains in this region are commonly designed for only 12-25mm/hr — blockage removes what little headroom exists.',
  },
  {
    key: 'embankment',
    label: 'Build / raise embankment',
    emoji: '🧱',
    color: '#78350f',
    kind: 'point',
    targetType: 'embankment',
    hint: 'Click on the BANK near the nullah (5-50m away) — not on the channel, a building, or a road',
    effect: { severity_reduction: 8 },
    effectLabel: '−8 severity locally (engineering estimate)',
    realBasis: 'Standard flood-engineering countermeasure; no site-specific real data available for this exact corridor yet.',
  },
  {
    key: 'widenChannel',
    label: 'Widen channel section',
    emoji: '📏',
    color: '#0284c7',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line at the narrow/bottleneck section — clicks off the waterway are rejected',
    effect: { drainage_capacity_gain_pct: 12 },
    effectLabel: '+12% flow capacity (engineering estimate)',
    realBasis: 'Standard hydraulic principle (wider channel = more flow capacity); not yet validated against this specific corridor.',
  },
  {
    key: 'removeEncroachment',
    label: 'Remove encroachment',
    emoji: '🏚️',
    color: '#b91c1c',
    kind: 'point',
    hint: 'Click illegal construction blocking the floodplain',
    effect: { drainage_capacity_gain_pct: 8 },
    effectLabel: '+8% floodplain capacity (estimate)',
    realBasis: 'Real finding: officials directly blamed encroachment along drains for worsening real monsoon flooding across Rawalpindi in Aug 2026.',
  },
  {
    key: 'retentionPond',
    label: 'Retention pond',
    emoji: '🌊',
    color: '#0d9488',
    kind: 'point',
    hint: 'Click where excess water can be stored upstream',
    effect: { severity_reduction: 6 },
    effectLabel: '−6 severity (engineering estimate)',
    realBasis: 'Same principle real dams (Rawal, Khanpur, Simly) use to hold back water — a smaller-scale version of a real, working mechanism.',
  },
  {
    key: 'warningGauge',
    label: 'Early warning gauge',
    emoji: '📡',
    color: '#7c3aed',
    kind: 'point',
    targetType: 'waterway',
    hint: 'Click ON the blue nullah line where the sensor should sit — clicks off the waterway are rejected',
    effect: {},
    effectLabel: 'earlier warning, no flood reduction',
    realBasis: 'A real system already exists: the Leh Nullah Flood Forecasting & Warning System (JICA, since 2007) — sirens + mosque loudspeakers. This measure represents extending that real coverage upstream into this corridor.',
  },
  {
    key: 'greenBuffer',
    label: 'Green buffer / plantation',
    emoji: '🌳',
    color: '#16a34a',
    kind: 'point',
    hint: 'Click where vegetation can slow runoff',
    effect: { severity_reduction: 3 },
    effectLabel: '−3 severity (engineering estimate)',
    realBasis: 'Standard hydrology principle (vegetation slows runoff); not yet validated against this specific corridor.',
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

// ---------------------------------------------------------------------
// Embankment placement validation. Unlike the waterway-snap actions
// above, an embankment must sit NEAR the nullah (on the bank) but NOT
// on the channel itself, not on a building, and not on a road --
// modeled as a real flood-engineering team would site one:
//   - >=5m from the waterway: clear of the channel/wetted area
//   - <=50m from the waterway: still actually defends this section
//   - not inside any building footprint
//   - >=15m from any road (room for construction access + public use)
//
// A real embankment has LENGTH, not just a point -- so once the user
// gives a length, the whole line (not just the anchor click) has to be
// checked against buildings/roads/waterway-distance, sampled every 5m.
// checkPointConstraints is the single source of truth for what makes
// ANY point valid, shared by both the single-click check and the
// full-line check so they can't drift apart from each other.
// ---------------------------------------------------------------------
const EMBANKMENT_MIN_DISTANCE_M = 5;
const EMBANKMENT_MAX_DISTANCE_M = 50;
const EMBANKMENT_ROAD_BUFFER_M = 15; // not just the road surface -- room for construction access + normal public use of the street
const EMBANKMENT_SAMPLE_INTERVAL_M = 5;

function checkPointConstraints(point, waterwaysGeoJSON, buildingsGeoJSON, roadsGeoJSON) {
  // Returns { ok: true } or { ok: false, reason: '<clause usable after "it" or "That point"> ' }
  if (buildingsGeoJSON && buildingsGeoJSON.features) {
    for (const feature of buildingsGeoJSON.features) {
      const geomType = feature.geometry && feature.geometry.type;
      if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') continue;
      if (turf.booleanPointInPolygon(point, feature)) {
        return { ok: false, reason: 'falls inside a building footprint' };
      }
    }
  }

  if (roadsGeoJSON && roadsGeoJSON.features && roadsGeoJSON.features.length > 0) {
    const nearestRoad = turf.nearestPointOnLine(roadsGeoJSON, point, { units: 'meters' });
    if (nearestRoad.properties.dist < EMBANKMENT_ROAD_BUFFER_M) {
      return { ok: false, reason: 'is only ' + Math.round(nearestRoad.properties.dist) + 'm from a road' };
    }
  }

  if (!waterwaysGeoJSON || !waterwaysGeoJSON.features || waterwaysGeoJSON.features.length === 0) {
    return { ok: false, reason: 'can\'t be checked against the nullah (data not loaded yet)' };
  }

  const nearestWaterway = turf.nearestPointOnLine(waterwaysGeoJSON, point, { units: 'meters' });
  const waterwayDistanceM = nearestWaterway.properties.dist;

  if (waterwayDistanceM < EMBANKMENT_MIN_DISTANCE_M) {
    return { ok: false, reason: 'is only ' + Math.round(waterwayDistanceM) + 'm from the nullah -- inside the channel itself' };
  }
  if (waterwayDistanceM > EMBANKMENT_MAX_DISTANCE_M) {
    return { ok: false, reason: 'is ' + Math.round(waterwayDistanceM) + 'm from the nearest nullah -- too far to defend it' };
  }

  return { ok: true };
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

export default function PlanWorkspace() {
  const router = useRouter();
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const waterwaysDataRef = useRef(null);
  const buildingsDataRef = useRef(null);
  const roadsDataRef = useRef(null);

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
  const [pendingEmbankment, setPendingEmbankment] = useState(null);
  const [embankmentForm, setEmbankmentForm] = useState({ length: 50, height: 1.5, material: 'earthen' });

  const activeToolRef = useRef(null);
  const planTypeRef = useRef('response');
  const startPointRef = useRef(null);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { planTypeRef.current = planType; }, [planType]);
  useEffect(() => { startPointRef.current = startPoint; }, [startPoint]);

  const TOOLS = planType === 'response' ? RESPONSE_TOOLS : PREVENTION_TOOLS;

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
          'circle-radius': 11,
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
        paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'embankment-lines-layer',
        type: 'line',
        source: 'embankment-lines',
        paint: { 'line-color': '#78350f', 'line-width': 6 },
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
        setClosedRoads(function (prev) {
          if (prev.indexOf(idx) !== -1) return prev;
          return prev.concat([idx]);
        });
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
          const pool = planTypeRef.current === 'response' ? RESPONSE_TOOLS : PREVENTION_TOOLS;
          const toolDef = pool.find(function (t) { return t.key === toolKey; });
          if (!toolDef) return;

          // Waterway-targeted prevention actions must land on/near a
          // real nullah segment -- reject and explain instead of
          // silently placing a marker wherever the user clicked.
          if (toolDef.targetType === 'waterway') {
            const result = findNearestWaterwaySegment(ev.lngLat, waterwaysDataRef.current, WATERWAY_SNAP_MAX_M);
            if (!result.accepted) {
              setToolError(result.reason);
              setTimeout(function () { setToolError(null); }, 3500);
              return;
            }
            setMarkers(function (prev) {
              return prev.concat([{
                planType: planTypeRef.current,
                type: toolKey,
                label: toolDef.label,
                emoji: toolDef.emoji,
                color: toolDef.color,
                effect: toolDef.effect || {},
                effectLabel: toolDef.effectLabel || null,
                lat: result.lat,
                lon: result.lng,
                targetSegmentName: result.segmentName,
                targetWaterwayId: result.waterwayId,
              }]);
            });
            return;
          }

          // Embankment: must be near the nullah bank, not on the channel,
          // not on a building, not on a road. Accepting the anchor point
          // opens the length/height/material form -- the actual wall
          // (and full-line feasibility check) happens on submit, since
          // we don't know the real footprint until we know the length.
          if (toolDef.targetType === 'embankment') {
            const result = validateEmbankmentPlacement(
              ev.lngLat,
              waterwaysDataRef.current,
              buildingsDataRef.current,
              roadsDataRef.current
            );
            if (!result.accepted) {
              setToolError(result.reason);
              setTimeout(function () { setToolError(null); }, 3500);
              setPendingEmbankment(null);
              return;
            }
            setPendingEmbankment({ lng: result.lng, lat: result.lat, waterwayDistanceM: result.waterwayDistanceM });
            return;
          }

          setMarkers(function (prev) {
            return prev.concat([{
              planType: planTypeRef.current,
              type: toolKey,
              label: toolDef.label,
              emoji: toolDef.emoji,
              color: toolDef.color,
              effect: toolDef.effect || {},
              effectLabel: toolDef.effectLabel || null,
              lat: ev.lngLat.lat,
              lon: ev.lngLat.lng,
            }]);
          });
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
        properties: { roadIndex: i, closed: closedRoads.indexOf(i) !== -1 },
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
          properties: { color: m.color, label: m.label },
          geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        };
      }),
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

  function submitEmbankment() {
    if (!pendingEmbankment) return;

    const lengthM = Number(embankmentForm.length);
    const heightM = Number(embankmentForm.height);
    if (!lengthM || lengthM <= 0 || !heightM || heightM <= 0) {
      setToolError('Enter a positive length and height before checking feasibility.');
      setTimeout(function () { setToolError(null); }, 3500);
      return;
    }

    const lineResult = buildEmbankmentLine(pendingEmbankment.lng, pendingEmbankment.lat, lengthM, waterwaysDataRef.current);
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

    setEmbankments(function (prev) {
      return prev.concat([{
        planType: 'prevention',
        lengthM: lengthM,
        heightM: heightM,
        material: embankmentForm.material,
        lineCoords: lineResult.lineCoords,
        anchorLng: pendingEmbankment.lng,
        anchorLat: pendingEmbankment.lat,
        waterwayDistanceM: pendingEmbankment.waterwayDistanceM,
      }]);
    });
    setPendingEmbankment(null);
  }

  function cancelEmbankment() {
    setPendingEmbankment(null);
  }

  function addNote() {
    const text = noteDraft.trim();
    if (!text) return;
    setCustomNotes(function (prev) { return prev.concat([{ planType: planType, text: text }]); });
    setNoteDraft('');
  }

  function undoLast() {
    if (embankments.length > 0) {
      setEmbankments(function (prev) { return prev.slice(0, -1); });
    } else if (markers.length > 0) {
      setMarkers(function (prev) { return prev.slice(0, -1); });
    } else if (closedRoads.length > 0) {
      setClosedRoads(function (prev) { return prev.slice(0, -1); });
    }
  }

  function clearAll() {
    setMarkers([]);
    setEmbankments([]);
    setClosedRoads([]);
    setCustomNotes([]);
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

  const activeToolDef = TOOLS.find(function (t) { return t.key === activeTool; });
  const currentMarkers = markers.filter(function (m) { return m.planType === planType; });
  const currentEmbankments = embankments.filter(function (e) { return e.planType === planType; });
  const currentNotes = customNotes.filter(function (n) { return n.planType === planType; });

  const totalDrainageGain = markers
    .filter(function (m) { return m.planType === 'prevention'; })
    .reduce(function (sum, m) { return sum + (m.effect && m.effect.drainage_capacity_gain_pct ? m.effect.drainage_capacity_gain_pct : 0); }, 0);
  const totalSeverityReduction = markers
    .filter(function (m) { return m.planType === 'prevention'; })
    .reduce(function (sum, m) { return sum + (m.effect && m.effect.severity_reduction ? m.effect.severity_reduction : 0); }, 0)
    // Embankments still use the same flat placeholder effect as other
    // engineering-estimate actions until the real before/after flood
    // simulation is wired in -- tracked as the next step, not yet built.
    + embankments.filter(function (e) { return e.planType === 'prevention'; }).length * 8;

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

      {pendingEmbankment && (
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
            🧱 Embankment at this point
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginBottom: 10 }}>
            {Math.round(pendingEmbankment.waterwayDistanceM)}m from the nullah. Set the real dimensions — we&apos;ll check the whole wall, not just this point.
          </div>

          <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Length (m)</label>
          <input
            type="number"
            value={embankmentForm.length}
            onChange={function (e) { setEmbankmentForm(function (f) { return Object.assign({}, f, { length: e.target.value }); }); }}
            min={10}
            max={300}
            style={{ width: '100%', padding: 6, marginTop: 3, marginBottom: 8, borderRadius: 8, border: '1px solid #cbd5e1', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, color: '#0f172a', background: '#ffffff' }}
          />

          <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Height (m)</label>
          <input
            type="number"
            value={embankmentForm.height}
            onChange={function (e) { setEmbankmentForm(function (f) { return Object.assign({}, f, { height: e.target.value }); }); }}
            min={0.5}
            max={5}
            step={0.1}
            style={{ width: '100%', padding: 6, marginTop: 3, marginBottom: 8, borderRadius: 8, border: '1px solid #cbd5e1', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, color: '#0f172a', background: '#ffffff' }}
          />

          <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Material</label>
          <select
            value={embankmentForm.material}
            onChange={function (e) { setEmbankmentForm(function (f) { return Object.assign({}, f, { material: e.target.value }); }); }}
            style={{ width: '100%', padding: 6, marginTop: 3, marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, color: '#0f172a', background: '#ffffff' }}
          >
            <option value="earthen">Earthen bund</option>
            <option value="concrete">Concrete wall</option>
            <option value="sandbag">Sandbag barrier</option>
          </select>

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={cancelEmbankment}
              style={{ flex: 1, padding: 8, borderRadius: 9, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={submitEmbankment}
              style={{ flex: 2, padding: 8, borderRadius: 9, border: 'none', background: '#78350f', color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
            >
              Check feasibility & add
            </button>
          </div>
        </div>
      )}

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
            : 'Fixes applied before a flood — see the effect below'}
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
            onChange={function (e) { setNoteDraft(e.target.value); }}
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
          <button
            onClick={addNote}
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
            Add to plan
          </button>
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
                <div key={i} style={{ fontSize: 10, color: '#94a3b8', marginLeft: 20 }}>
                  {e.lengthM}m long, {e.heightM}m high, {e.material}
                </div>
              );
            })}
          </div>
        )}

        {TOOLS.filter(function (t) { return t.kind === 'point'; }).map(function (t) {
          const matching = currentMarkers.filter(function (m) { return m.type === t.key; });
          if (matching.length === 0) return null;
          const segmentNames = Array.from(new Set(
            matching.map(function (m) { return m.targetSegmentName; }).filter(Boolean)
          ));
          return (
            <div key={t.key} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
              {t.emoji} <b>{matching.length}</b> × {t.label}
              {segmentNames.length > 0 && (
                <div style={{ fontSize: 10, color: '#94a3b8', marginLeft: 20 }}>
                  on {segmentNames.join(', ')}
                </div>
              )}
            </div>
          );
        })}

        {currentNotes.length > 0 && (
          <div style={{ marginTop: 8, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>
              Custom actions
            </div>
            {currentNotes.map(function (n, i) {
              return (
                <div key={i} style={{ fontSize: 11.5, color: '#334155', marginBottom: 4 }}>
                  ✍️ {n.text}
                </div>
              );
            })}
          </div>
        )}

        {planType === 'prevention' && (totalDrainageGain > 0 || totalSeverityReduction > 0) && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 11,
              background: '#f0fdfa',
              border: '1px solid #99f6e4',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, color: '#0f766e', marginBottom: 4 }}>
              Estimated combined effect
            </div>
            {totalDrainageGain > 0 && (
              <div style={{ fontSize: 11.5, color: '#134e4a' }}>
                +{totalDrainageGain}% drainage capacity
              </div>
            )}
            {totalSeverityReduction > 0 && (
              <div style={{ fontSize: 11.5, color: '#134e4a' }}>
                −{totalSeverityReduction} severity
              </div>
            )}
            <div style={{ fontSize: 10, color: '#5eead4', marginTop: 4 }}>
              Re-run comparison coming next
            </div>
          </div>
        )}
      </div>

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}