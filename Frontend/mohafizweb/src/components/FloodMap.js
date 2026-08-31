'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Our locked, TESTED study area — Nullah Leh / Korang Nullah corridor
const BBOX = {
  north: 33.7350,
  south: 33.6700,
  east: 73.0850,
  west: 73.0100,
};

// A ~10km buffer around the study area, so judges can see real surrounding
// context (rest of Islamabad) while our tested corridor stays clearly marked.
const CONTEXT_BBOX = {
  north: BBOX.north + 0.09,
  south: BBOX.south - 0.09,
  east: BBOX.east + 0.108,
  west: BBOX.west - 0.108,
};

const TARGET_VIEW = {
  center: [(BBOX.east + BBOX.west) / 2, (BBOX.north + BBOX.south) / 2],
  zoom: 15,
  pitch: 55,
  bearing: -20,
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

// Bright magenta — deliberately unlike greenery (green), water (blue),
// hospitals (red) or flood (red-orange), so the study boundary never blends in.
const STUDY_COLOR = '#D946EF';

const CAUSES = [
  {
    key: 'rainfall',
    label: 'Rainfall',
    emoji: '🌧️',
    color: '#0EA5E9',
    colorLight: '#E0F2FE',
    fields: [
      { key: 'intensity_mm_per_hr', label: 'Rain intensity', unit: 'mm/hr', min: 2, max: 200, step: 1,
        helperText: function(v) {
          if (v <= 10) return 'Low intensity — impact increases with duration';
          if (v <= 50) return 'Moderate rainfall';
          if (v <= 100) return 'Heavy rainfall';
          return 'Extreme rainfall';
        } },
      { key: 'duration_hr', label: 'Duration', unit: 'hours', min: 1, max: 24, step: 0.5,
        helperText: function(v) {
          if (v <= 3) return 'Short burst';
          if (v <= 8) return 'Sustained rainfall';
          return 'Prolonged event';
        } },
    ],
  },
  {
    key: 'river_overflow',
    label: 'River Overflow',
    emoji: '🌊',
    color: '#06B6D4',
    colorLight: '#CFFAFE',
    fields: [{ key: 'bank_rise_m', label: 'Overflow depth', unit: 'meters', min: 0.1, max: 5, step: 0.1,
      helperText: function(v) {
        if (v <= 0.5) return 'Water begins overtopping the river bank';
        if (v <= 2) return 'Significant overflow';
        return 'Major river flooding';
      } }],
  },
  {
    key: 'drainage_failure',
    label: 'Drainage Failure',
    emoji: '🕳️',
    color: '#F59E0B',
    colorLight: '#FEF3C7',
    fields: [
      { key: 'rainfall_mm', label: 'Rainfall', unit: 'mm', min: 0, max: 150, step: 5,
        helperText: function(v) {
          if (v <= 20) return 'Light rainfall on compromised drains';
          if (v <= 60) return 'Moderate rainfall adding to drain load';
          return 'Heavy rainfall overwhelming drains';
        } },
      { key: 'drainage_capacity_pct', label: 'Drainage capacity lost', unit: '%', min: 20, max: 100, step: 5,
        helperText: function(v) {
          if (v <= 30) return 'Minor drainage capacity loss';
          if (v <= 55) return 'Major drainage capacity loss';
          if (v <= 80) return 'Severe drainage capacity loss';
          return 'Complete drainage failure';
        } },
    ],
  },
  {
    key: 'dam_release',
    label: 'Dam Release',
    emoji: '🚰',
    color: '#8B5CF6',
    colorLight: '#EDE9FE',
    fields: [{ key: 'release_intensity_pct', label: 'Release above normal', unit: '%', min: 10, max: 300, step: 5,
      helperText: function(v) {
        if (v <= 20) return v + '% above normal release';
        if (v <= 100) return 'Significant surplus release';
        return 'Emergency-level release';
      } }],
  },
];

export default function FloodMap() {
  const mapContainer = useRef(null);
    const router = useRouter();
  const mapRef = useRef(null);
  const [status, setStatus] = useState('loading map...');
  const [opacity, setOpacity] = useState(0.4);

  const [layers, setLayers] = useState({
    base: true,
    buildings: true,
    hospitals: true,
    shelters: false,
    water: true,
    greenery: true,
    studyArea: true,
    floodOverlay: true,
    cutRoads: true,
    drainageRisk: true,
    lowPoints: true,
  });

  const [causeType, setCauseType] = useState('rainfall');
  const [causeParams, setCauseParams] = useState({
    rainfall: { intensity_mm_per_hr: 2, duration_hr: 1 },
    river_overflow: { bank_rise_m: 0.1 },
    drainage_failure: { rainfall_mm: 10, drainage_capacity_pct: 20 },
    dam_release: { release_intensity_pct: 10 },
  });
  const [userId, setUserId] = useState('32c7d0c2-b311-45a3-b211-a60ef33abbfd');
  const [floodLoading, setFloodLoading] = useState(false);
  const [floodError, setFloodError] = useState(null);
  const [floodResult, setFloodResult] = useState(null);

  useEffect(() => {
    if (mapRef.current) return;

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
      ...TARGET_VIEW,
      maxBounds: [
        [CONTEXT_BBOX.west, CONTEXT_BBOX.south],
        [CONTEXT_BBOX.east, CONTEXT_BBOX.north],
      ],
      minZoom: 10,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));

    mapRef.current.on('load', async () => {
      try {
        setStatus('loading greenery...');
        const green = await (await fetch('/data/greenery.geojson')).json();
        mapRef.current.addSource('greenery', { type: 'geojson', data: green });
        mapRef.current.addLayer({
          id: 'greenery-fill',
          type: 'fill',
          source: 'greenery',
          paint: { 'fill-color': '#4ade80', 'fill-opacity': 0.4 },
        });

        setStatus('loading water bodies...');
        const waterBodies = await (await fetch('/data/water_bodies.geojson')).json();
        mapRef.current.addSource('water-bodies', { type: 'geojson', data: waterBodies });
        mapRef.current.addLayer({
          id: 'water-bodies-fill',
          type: 'fill',
          source: 'water-bodies',
          paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.6 },
        });

        setStatus('loading Nullah Leh...');
        const waterways = await (await fetch('/data/waterways.geojson')).json();
        mapRef.current.addSource('waterways', { type: 'geojson', data: waterways });
        mapRef.current.addLayer({
          id: 'waterways-line',
          type: 'line',
          source: 'waterways',
          paint: {
            'line-color': '#0284c7',
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 8],
            'line-opacity': 0.9,
          },
        });
        mapRef.current.addLayer({
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

        setStatus('loading buildings...');
        const buildings = await (await fetch('/data/buildings.geojson')).json();
        mapRef.current.addSource('buildings', { type: 'geojson', data: buildings });
        mapRef.current.addLayer({
          id: 'buildings-3d',
          type: 'fill-extrusion',
          source: 'buildings',
          paint: {
            'fill-extrusion-color': '#94a3b8',
            'fill-extrusion-height': [
              'case',
              ['!=', ['get', 'height'], null],
              ['to-number', ['get', 'height'], 6],
              ['!=', ['get', 'building:levels'], null],
              ['*', ['to-number', ['get', 'building:levels'], 2], 2.5],
              6,
            ],
            'fill-extrusion-opacity': 0.4,
          },
        });

        // ---------------------------------------------------------------
        // RAINFALL drainage-risk layer. Terrain-derived pockets where
        // water pools when urban drainage is overwhelmed -- independent
        // of the nullah, which is the whole point: pluvial flooding is
        // not fluvial flooding. Built by
        // Backend/scripts/build_drainage_risk.py.
        // ---------------------------------------------------------------
        setStatus('loading drainage risk...');
        const risk = await (await fetch('/data/drainage_risk.geojson')).json();
        mapRef.current.addSource('drainage-risk', { type: 'geojson', data: risk });
        mapRef.current.addLayer({
          id: 'drainage-risk-fill',
          type: 'fill',
          source: 'drainage-risk',
          paint: {
            'fill-color': [
              'match', ['get', 'risk_class'],
              'severe', '#b91c1c',
              'high', '#ea580c',
              'moderate', '#f59e0b',
              '#f59e0b',
            ],
            'fill-opacity': 0.45,
          },
        });
        mapRef.current.addLayer({
          id: 'drainage-risk-outline',
          type: 'line',
          source: 'drainage-risk',
          paint: {
            'line-color': [
              'match', ['get', 'risk_class'],
              'severe', '#7f1d1d',
              'high', '#9a3412',
              'moderate', '#92400e',
              '#92400e',
            ],
            'line-width': 1.2,
          },
        });

        mapRef.current.on('click', 'drainage-risk-fill', (e) => {
          const p = e.features[0].properties;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:system-ui;font-size:12px;min-width:190px">
                 <strong>Drainage-risk zone #${p.zone_id}</strong><br/>
                 <span style="color:#b91c1c;font-weight:700;text-transform:uppercase">${p.risk_class}</span><br/>
                 <div style="margin-top:5px;color:#334155">
                   pools up to <b>${p.max_sink_m}m</b> deep (mean ${p.mean_sink_m}m)<br/>
                   area <b>${(p.area_m2 / 10000).toFixed(2)} ha</b> · ${p.cells} cells<br/>
                   nearest drain <b>${p.min_dist_to_drain_m}m</b><br/>
                   built cover ${(p.impervious_frac * 100).toFixed(0)}%
                 </div>
               </div>`
            )
            .addTo(mapRef.current);
        });
        mapRef.current.on('mouseenter', 'drainage-risk-fill', () => {
          mapRef.current.getCanvas().style.cursor = 'pointer';
        });
        mapRef.current.on('mouseleave', 'drainage-risk-fill', () => {
          mapRef.current.getCanvas().style.cursor = '';
        });

        setStatus('loading road low points...');
        const lowPts = await (await fetch('/data/road_low_points.geojson')).json();
        mapRef.current.addSource('road-low-points', { type: 'geojson', data: lowPts });
        // Ordinary terrain sags: real dips, but not grade-separated.
        mapRef.current.addLayer({
          id: 'road-low-points-sag',
          type: 'circle',
          source: 'road-low-points',
          filter: ['==', ['get', 'kind'], 'sag'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 18, 5],
            'circle-color': '#0891b2',
            'circle-opacity': 0.55,
          },
        });
        // Underpasses: a road crosses without sharing a junction node.
        // These are the ones that drown vehicles.
        mapRef.current.addLayer({
          id: 'road-low-points-underpass',
          type: 'circle',
          source: 'road-low-points',
          filter: ['==', ['get', 'kind'], 'underpass'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 5, 18, 11],
            'circle-color': '#1d4ed8',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        });

        mapRef.current.on('click', 'road-low-points-underpass', (e) => {
          const p = e.features[0].properties;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:system-ui;font-size:12px">
                 <strong>Underpass / sag</strong><br/>
                 <span style="color:#64748b">${p.name || 'unnamed'} · ${p.highway}</span><br/>
                 <div style="margin-top:4px;color:#334155">
                   road dips <b>${p.drop_m}m</b> below both approaches<br/>
                   terrain sink here: <b>${p.sink_depth_m}m</b>
                 </div>
               </div>`
            )
            .addTo(mapRef.current);
        });

        setStatus('loading facilities...');
        const facilities = await (await fetch('/data/facilities.geojson')).json();
        mapRef.current.addSource('facilities', { type: 'geojson', data: facilities });

        mapRef.current.addLayer({
          id: 'shelters',
          type: 'circle',
          source: 'facilities',
          filter: [
            'in',
            ['get', 'amenity'],
            ['literal', ['school', 'college', 'university', 'community_centre', 'shelter', 'place_of_worship']],
          ],
          layout: { visibility: 'none' },
          paint: {
            'circle-radius': 4,
            'circle-color': '#facc15',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#78350f',
            'circle-opacity': 0.85,
          },
        });

        mapRef.current.addLayer({
          id: 'hospitals-glow',
          type: 'circle',
          source: 'facilities',
          filter: ['in', ['get', 'amenity'], ['literal', ['hospital', 'clinic', 'doctors']]],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 10, 18, 24],
            'circle-color': '#ef4444',
            'circle-opacity': 0.25,
            'circle-blur': 0.6,
          },
        });

        mapRef.current.addLayer({
          id: 'hospitals',
          type: 'circle',
          source: 'facilities',
          filter: ['in', ['get', 'amenity'], ['literal', ['hospital', 'clinic', 'doctors']]],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 5, 18, 11],
            'circle-color': '#dc2626',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          },
        });

        mapRef.current.on('click', 'hospitals', (e) => {
          const props = e.features[0].properties;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${props.name || 'Unnamed facility'}</strong><br/><span style="color:#64748b">${props.amenity || ''}</span>`
            )
            .addTo(mapRef.current);
        });

        mapRef.current.on('mouseenter', 'hospitals', () => {
          mapRef.current.getCanvas().style.cursor = 'pointer';
        });
        mapRef.current.on('mouseleave', 'hospitals', () => {
          mapRef.current.getCanvas().style.cursor = '';
        });

        // ---------------------------------------------------------------
        // STUDY AREA BOUNDARY — added LAST so it draws on top of everything
        // else (greenery, buildings, water). Layers added later render above
        // earlier ones in MapLibre, which is why this must come at the end.
        // ---------------------------------------------------------------
        mapRef.current.addSource('study-area', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [BBOX.west, BBOX.south],
                  [BBOX.east, BBOX.south],
                  [BBOX.east, BBOX.north],
                  [BBOX.west, BBOX.north],
                  [BBOX.west, BBOX.south],
                ],
              ],
            },
          },
        });

        mapRef.current.addLayer({
          id: 'study-area-fill',
          type: 'fill',
          source: 'study-area',
          paint: { 'fill-color': STUDY_COLOR, 'fill-opacity': 0.07 },
        });

        mapRef.current.addLayer({
          id: 'study-area-outline',
          type: 'line',
          source: 'study-area',
          paint: {
            'line-color': STUDY_COLOR,
            'line-width': 5,
            'line-dasharray': [3, 2],
            'line-opacity': 1,
          },
        });

        setStatus('ready ✓');
      } catch (err) {
        setStatus('ERROR: ' + err.message);
      }
    });
  }, []);

  function applyFrame(frame, bounds) {
    const map = mapRef.current;
    if (!map) return;
    const [west, south, east, north] = bounds;
    const coords = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];

    if (map.getSource('flood-overlay')) {
      map.getSource('flood-overlay').updateImage({ url: frame.flood_image });
    } else {
      map.addSource('flood-overlay', { type: 'image', url: frame.flood_image, coordinates: coords });
      // Insert the flood BELOW the study-area outline so the boundary
      // stays visible even when the whole area is underwater.
      map.addLayer(
        {
          id: 'flood-overlay-layer',
          type: 'raster',
          source: 'flood-overlay',
          paint: { 'raster-opacity': 0.85 },
        },
        'study-area-fill'
      );
    }

    if (map.getLayer('buildings-3d')) {
      map.setPaintProperty('buildings-3d', 'fill-extrusion-color', [
        'case',
        ['<=', ['coalesce', ['get', 'base_elevation_m'], 9999], frame.water_level_m],
        '#7f1d1d',
        '#94a3b8',
      ]);
    }
  }

  function applyFinalRoads(result) {
    const map = mapRef.current;
    if (!map) return;

    if (map.getLayer('flood-cut-roads-layer')) map.removeLayer('flood-cut-roads-layer');
    if (map.getSource('flood-cut-roads')) map.removeSource('flood-cut-roads');

    const roadFeatures = result.flooded_roads.map((coords) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    }));

    map.addSource('flood-cut-roads', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: roadFeatures },
    });
    map.addLayer(
      {
        id: 'flood-cut-roads-layer',
        type: 'line',
        source: 'flood-cut-roads',
        paint: { 'line-color': '#dc2626', 'line-width': 3, 'line-opacity': 0.9 },
      },
      'study-area-fill'
    );
  }

  async function animateFlood(data) {
    for (const frame of data.frames) {
      applyFrame(frame, data.flood_image_bounds);
      await new Promise((r) => setTimeout(r, 550));
    }
    applyFinalRoads(data);
  }

  // Rainfall severity is still validated on the backend as a PMD/FFD
  // 24-hour accumulation BAND (see flood_engine.rainfall_band_severity),
  // not a live intensity feed -- that discrete-band model is what the
  // Response Plan's rainfall actions gate on. The intensity + duration
  // sliders are the familiar input; their total is bucketed into the
  // same five PMD bands right here before the request is sent, so
  // nothing downstream changes.
  function rainfallTotalToBand(totalMm) {
    if (totalMm <= 10) return 'light';
    if (totalMm <= 30) return 'moderate';
    if (totalMm <= 70) return 'heavy';
    if (totalMm <= 150) return 'very_heavy';
    return 'extremely_heavy';
  }

  async function runFloodScenario() {
    setFloodLoading(true);
    setFloodError(null);
    try {
      let params = causeParams[causeType];
      if (causeType === 'drainage_failure') {
        params = { ...params, drainage_capacity_pct: 100 - params.drainage_capacity_pct };
      } else if (causeType === 'rainfall') {
        const totalMm = params.intensity_mm_per_hr * params.duration_hr;
        params = { band: rainfallTotalToBand(totalMm) };
      }
      const res = await fetch(`${API_URL}/flood`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause_type: causeType,
          params,
          user_id: userId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Something went wrong.');
      setFloodResult(data);
      await animateFlood(data);
    } catch (err) {
      setFloodError(err.message);
    } finally {
      setFloodLoading(false);
    }
  }

  function updateParam(fieldKey, value) {
    setCauseParams((prev) => ({
      ...prev,
      [causeType]: { ...prev[causeType], [fieldKey]: parseFloat(value) },
    }));
  }

  function handleOpacityChange(e) {
    const value = parseFloat(e.target.value);
    setOpacity(value);
    if (mapRef.current?.getLayer('buildings-3d')) {
      mapRef.current.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', value);
    }
  }

  function setVis(layerId, visible) {
    if (mapRef.current?.getLayer(layerId)) {
      mapRef.current.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    }
  }

  function toggle(key) {
    const next = !layers[key];
    setLayers({ ...layers, [key]: next });

    if (key === 'base') {
      mapRef.current?.setPaintProperty('osm-raster-layer', 'raster-opacity', next ? 1 : 0);
    } else if (key === 'buildings') {
      setVis('buildings-3d', next);
    } else if (key === 'hospitals') {
      setVis('hospitals', next);
      setVis('hospitals-glow', next);
    } else if (key === 'shelters') {
      setVis('shelters', next);
    } else if (key === 'water') {
      setVis('waterways-line', next);
      setVis('water-bodies-fill', next);
    } else if (key === 'greenery') {
      setVis('greenery-fill', next);
    } else if (key === 'studyArea') {
      setVis('study-area-fill', next);
      setVis('study-area-outline', next);
    } else if (key === 'floodOverlay') {
      setVis('flood-overlay-layer', next);
    } else if (key === 'cutRoads') {
      setVis('flood-cut-roads-layer', next);
    } else if (key === 'drainageRisk') {
      setVis('drainage-risk-fill', next);
      setVis('drainage-risk-outline', next);
    } else if (key === 'lowPoints') {
      setVis('road-low-points-sag', next);
      setVis('road-low-points-underpass', next);
    }
  }

  function viewWholeCorridor() {
    mapRef.current?.fitBounds(
      [
        [BBOX.west, BBOX.south],
        [BBOX.east, BBOX.north],
      ],
      { padding: 40, pitch: 45, bearing: 0, duration: 1000 }
    );
  }

  function viewContextArea() {
    mapRef.current?.fitBounds(
      [
        [CONTEXT_BBOX.west, CONTEXT_BBOX.south],
        [CONTEXT_BBOX.east, CONTEXT_BBOX.north],
      ],
      { padding: 30, pitch: 20, bearing: 0, duration: 1000 }
    );
  }

  const LAYER_LIST = [
    // Named "modeled area", not "study area": outside this rectangle no
    // terrain data exists, so the absence of a risk zone there says
    // nothing at all. Users need to see that edge.
    { key: 'studyArea', label: 'Modeled area (terrain)', color: STUDY_COLOR },
    { key: 'drainageRisk', label: 'Drainage-risk zones', color: '#ea580c' },
    { key: 'lowPoints', label: 'Underpasses / road sags', color: '#1d4ed8' },
    { key: 'hospitals', label: 'Hospitals (42)', color: '#dc2626' },
    { key: 'shelters', label: 'Schools / shelters', color: '#facc15' },
    { key: 'water', label: 'Nullah Leh + water', color: '#0284c7' },
    { key: 'greenery', label: 'Green spaces', color: '#4ade80' },
    { key: 'buildings', label: 'Buildings (3D)', color: '#94a3b8' },
    { key: 'base', label: 'Base map', color: '#94a3b8' },
  ];

  const activeCause = CAUSES.find((c) => c.key === causeType);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#0f172a' }}>
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 999,
          background: 'rgba(0,0,0,0.88)',
          padding: '12px',
          fontFamily: 'monospace',
          fontSize: '12px',
          borderRadius: '8px',
          width: '230px',
        }}
      >
        <div style={{ color: status.startsWith('ERROR') ? '#ff6b6b' : '#2DD4BF', marginBottom: '10px' }}>
          {status}
        </div>

        {LAYER_LIST.map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => toggle(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              marginBottom: '5px',
              padding: '6px 8px',
              borderRadius: '5px',
              border: '1px solid ' + (layers[key] ? color : '#334155'),
              background: layers[key] ? 'rgba(255,255,255,0.06)' : 'transparent',
              color: layers[key] ? '#e2e8f0' : '#64748b',
              fontFamily: 'monospace',
              fontSize: '11.5px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '2px',
                background: layers[key] ? color : 'transparent',
                border: '1px solid ' + color,
                flexShrink: 0,
              }}
            />
            {label}
          </button>
        ))}

        {floodResult && (
          <>
            <div style={{ borderTop: '1px solid #334155', margin: '8px 0' }} />
            {[
              { key: 'floodOverlay', label: 'Flood extent', color: '#2563eb' },
              { key: 'cutRoads', label: 'Cut roads', color: '#dc2626' },
            ].map(({ key, label, color }) => (
              <button
                key={key}
                onClick={() => toggle(key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  marginBottom: '5px',
                  padding: '6px 8px',
                  borderRadius: '5px',
                  border: '1px solid ' + (layers[key] ? color : '#334155'),
                  background: layers[key] ? 'rgba(255,255,255,0.06)' : 'transparent',
                  color: layers[key] ? '#e2e8f0' : '#64748b',
                  fontFamily: 'monospace',
                  fontSize: '11.5px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '2px',
                    background: layers[key] ? color : 'transparent',
                    border: '1px solid ' + color,
                    flexShrink: 0,
                  }}
                />
                {label}
              </button>
            ))}
          </>
        )}

        {layers.buildings && (
          <div style={{ marginTop: '10px' }}>
            <label style={{ display: 'block', color: '#9fb3c8', marginBottom: '4px' }}>
              building opacity: {Math.round(opacity * 100)}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={handleOpacityChange}
              style={{ width: '100%', cursor: 'pointer' }}
            />
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 999, display: 'flex', gap: '8px' }}>
        <button
          onClick={viewContextArea}
          style={{
            background: 'rgba(0,0,0,0.8)',
            color: '#2DD4BF',
            border: '1px solid #2DD4BF',
            borderRadius: '6px',
            padding: '8px 14px',
            fontWeight: 600,
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          ~10km context
        </button>
        <button
          onClick={viewWholeCorridor}
          style={{
            background: '#2DD4BF',
            color: '#06231F',
            border: 'none',
            borderRadius: '6px',
            padding: '8px 14px',
            fontWeight: 600,
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Tested corridor
        </button>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          zIndex: 999,
          background: '#ffffff',
          borderRadius: '20px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
          padding: '18px',
          width: '340px',
          maxHeight: '80vh',
          overflowY: 'auto',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: '16px', fontWeight: 800, color: '#0f172a', marginBottom: '2px' }}>
          🌊 Flood Scenario
        </div>
        <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
          Pick a cause, set the numbers, run the simulation
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
          {CAUSES.map((cause) => {
            const active = causeType === cause.key;
            return (
              <button
                key={cause.key}
                onClick={() => setCauseType(cause.key)}
                style={{
                  padding: '10px 8px',
                  borderRadius: '14px',
                  border: active ? `2px solid ${cause.color}` : '2px solid #e2e8f0',
                  background: active ? cause.colorLight : '#f8fafc',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ fontSize: '22px', marginBottom: '2px' }}>{cause.emoji}</div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: active ? cause.color : '#475569' }}>
                  {cause.label}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ marginBottom: '14px' }}>
          {activeCause.fields.map((field) => (
            <div key={field.key} style={{ marginBottom: '10px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#334155',
                  marginBottom: '4px',
                }}
              >
                <span>{field.label}</span>
                <span style={{ color: activeCause.color }}>
                  {causeParams[causeType][field.key]} {field.unit}
                </span>
              </div>
              <input
                type="range"
                min={field.min}
                max={field.max}
                step={field.step}
                value={causeParams[causeType][field.key]}
                onChange={(e) => updateParam(field.key, e.target.value)}
                style={{ width: '100%', accentColor: activeCause.color, cursor: 'pointer' }}
              />
              {field.helperText && (
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  {field.helperText(causeParams[causeType][field.key])}
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={runFloodScenario}
          disabled={floodLoading}
          style={{
            width: '100%',
            padding: '12px',
            borderRadius: '14px',
            border: 'none',
            background: floodLoading ? '#94a3b8' : `linear-gradient(135deg, ${activeCause.color}, ${activeCause.color}cc)`,
            color: 'white',
            fontWeight: 800,
            fontSize: '14px',
            cursor: floodLoading ? 'default' : 'pointer',
            boxShadow: floodLoading ? 'none' : `0 6px 16px ${activeCause.color}55`,
          }}
        >
          {floodLoading ? '🌊 Water rising...' : '▶ Run Flood Simulation'}
        </button>

        {floodError && (
          <div
            style={{
              marginTop: '10px',
              padding: '10px',
              borderRadius: '10px',
              background: '#fee2e2',
              color: '#dc2626',
              fontSize: '12px',
            }}
          >
            {floodError}
          </div>
        )}

        {floodResult && (
          <div style={{ marginTop: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div style={{ background: '#eff6ff', borderRadius: '12px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#2563eb' }}>
                {floodResult.flooded_percent}%
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600 }}>terrain flooded</div>
            </div>
            <div style={{ background: '#fef2f2', borderRadius: '12px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#dc2626' }}>
                {floodResult.flooded_road_count}
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600 }}>roads cut</div>
            </div>
            <div style={{ background: '#f0fdf4', borderRadius: '12px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#16a34a' }}>
                {floodResult.severity > 0 ? floodResult.avg_depth_m + 'm' : '—'}
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600 }}>avg water depth</div>
            </div>
            <div style={{ background: '#fefce8', borderRadius: '12px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#ca8a04' }}>
                {floodResult.severity}
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600 }}>
                {floodResult.rainfall_band ? floodResult.rainfall_band.label + ' (' + floodResult.rainfall_band.plan_mm + 'mm planned)' : 'severity'}
              </div>
            </div>
          </div>
        )}
        {floodResult && floodResult.severity === 0 && (
          <div
            style={{
              marginTop: '12px',
              padding: '12px',
              borderRadius: '12px',
              background: '#f0fdf4',
              border: '1px solid #86efac',
              fontSize: '12px',
              color: '#166534',
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            ✅ No flooding expected — this rainfall is within normal drainage capacity for this area.
          </div>
        )}
        {floodResult && floodResult.severity > 0 && (
          <button
            onClick={() => {
              sessionStorage.setItem('mohafiz_scenario', JSON.stringify(floodResult));
              router.push('/plan');
            }}
            style={{
              width: '100%',
              marginTop: '12px',
              padding: '12px',
              borderRadius: '14px',
              border: 'none',
              background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
              color: 'white',
              fontWeight: 800,
              fontSize: '14px',
              cursor: 'pointer',
              boxShadow: '0 6px 16px #dc262655',
            }}
          >
            🗺️ Open Response Plan →
          </button>
        )}
        <div style={{ marginTop: '12px', fontSize: '10px', color: '#94a3b8' }}>
          running as test account —{' '}
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
              padding: '2px 6px',
              fontSize: '10px',
              width: '140px',
            }}
          />
        </div>
      </div>

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
