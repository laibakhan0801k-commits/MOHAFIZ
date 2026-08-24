'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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
  { key: 'desilt', label: 'Desilt nullah section', emoji: '🪣', color: '#0891b2', kind: 'point', hint: 'Click a nullah section that needs silt removal', effect: { drainage_capacity_gain_pct: 15 }, effectLabel: '+15% channel capacity' },
  { key: 'clearDrains', label: 'Clear blocked drains', emoji: '🕳️', color: '#f59e0b', kind: 'point', hint: 'Click an area where storm drains are choked', effect: { drainage_capacity_gain_pct: 10 }, effectLabel: '+10% drainage capacity' },
  { key: 'embankment', label: 'Build / raise embankment', emoji: '🧱', color: '#78350f', kind: 'point', hint: 'Click where a protective embankment is needed', effect: { severity_reduction: 8 }, effectLabel: '−8 severity locally' },
  { key: 'widenChannel', label: 'Widen channel section', emoji: '📏', color: '#0284c7', kind: 'point', hint: 'Click a narrow channel section that bottlenecks flow', effect: { drainage_capacity_gain_pct: 12 }, effectLabel: '+12% flow capacity' },
  { key: 'removeEncroachment', label: 'Remove encroachment', emoji: '🏚️', color: '#b91c1c', kind: 'point', hint: 'Click illegal construction blocking the floodplain', effect: { drainage_capacity_gain_pct: 8 }, effectLabel: '+8% floodplain capacity' },
  { key: 'retentionPond', label: 'Retention pond', emoji: '🌊', color: '#0d9488', kind: 'point', hint: 'Click where excess water can be stored upstream', effect: { severity_reduction: 6 }, effectLabel: '−6 severity' },
  { key: 'warningGauge', label: 'Early warning gauge', emoji: '📡', color: '#7c3aed', kind: 'point', hint: 'Click where a water-level sensor should be installed', effect: {}, effectLabel: 'earlier warning, no flood reduction' },
  { key: 'greenBuffer', label: 'Green buffer / plantation', emoji: '🌳', color: '#16a34a', kind: 'point', hint: 'Click where vegetation can slow runoff', effect: { severity_reduction: 3 }, effectLabel: '−3 severity (slower runoff)' },
];

export default function PlanWorkspace() {
  const router = useRouter();
  const mapContainer = useRef(null);
  const mapRef = useRef(null);

  const [scenario, setScenario] = useState(null);
  const [status, setStatus] = useState('loading scenario...');
  const [planType, setPlanType] = useState('response');
  const [activeTool, setActiveTool] = useState(null);
  const [closedRoads, setClosedRoads] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [customNotes, setCustomNotes] = useState([]);
  const [noteDraft, setNoteDraft] = useState('');

  const activeToolRef = useRef(null);
  const planTypeRef = useRef('response');
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { planTypeRef.current = planType; }, [planType]);

  const TOOLS = planType === 'response' ? RESPONSE_TOOLS : PREVENTION_TOOLS;

  useEffect(() => {
    const raw = sessionStorage.getItem('mohafiz_scenario');
    if (!raw) {
      setStatus('No scenario found. Run a simulation first.');
      return;
    }
    setScenario(JSON.parse(raw));
  }, []);

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
        map.addSource('waterways', { type: 'geojson', data: waterways });
        map.addLayer({
          id: 'waterways-line',
          type: 'line',
          source: 'waterways',
          paint: { 'line-color': '#0284c7', 'line-width': 3, 'line-opacity': 0.8 },
        });
      } catch (err) {
        console.error('waterways failed', err);
      }

      try {
        const buildings = await (await fetch('/data/buildings.geojson')).json();
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
        new maplibregl.Popup()
          .setLngLat(ev.lngLat)
          .setHTML('<strong>' + p.name + '</strong><br/><span style="color:#64748b">' + p.amenity + ' — affected</span>')
          .addTo(map);
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
        if (!toolKey || toolKey === 'closeRoad') return;
        const pool = planTypeRef.current === 'response' ? RESPONSE_TOOLS : PREVENTION_TOOLS;
        const toolDef = pool.find(function (t) { return t.key === toolKey; });
        if (!toolDef) return;
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
      });

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

  function addNote() {
    const text = noteDraft.trim();
    if (!text) return;
    setCustomNotes(function (prev) { return prev.concat([{ planType: planType, text: text }]); });
    setNoteDraft('');
  }

  function undoLast() {
    if (markers.length > 0) {
      setMarkers(function (prev) { return prev.slice(0, -1); });
    } else if (closedRoads.length > 0) {
      setClosedRoads(function (prev) { return prev.slice(0, -1); });
    }
  }

  function clearAll() {
    setMarkers([]);
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
  const currentNotes = customNotes.filter(function (n) { return n.planType === planType; });

  const totalDrainageGain = markers
    .filter(function (m) { return m.planType === 'prevention'; })
    .reduce(function (sum, m) { return sum + (m.effect && m.effect.drainage_capacity_gain_pct ? m.effect.drainage_capacity_gain_pct : 0); }, 0);
  const totalSeverityReduction = markers
    .filter(function (m) { return m.planType === 'prevention'; })
    .reduce(function (sum, m) { return sum + (m.effect && m.effect.severity_reduction ? m.effect.severity_reduction : 0); }, 0);

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

        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', fontSize: 11.5, color: '#94a3b8' }}>
          <span><b style={{ color: '#f87171' }}>{scenario.affected_building_count}</b> buildings</span>
          <span><b style={{ color: '#f87171' }}>{scenario.flooded_road_count}</b> roads flooded</span>
          <span><b style={{ color: '#f87171' }}>{hospitalCount}</b> hospitals at risk</span>
          <span><b style={{ color: '#38bdf8' }}>{scenario.water_level_m}m</b> water</span>
        </div>
      </div>

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

        {currentMarkers.length === 0 && currentNotes.length === 0 && closedRoads.length === 0 && (
          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
            Nothing added yet. Pick an action, then click the map.
          </div>
        )}

        {planType === 'response' && closedRoads.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
            🚧 <b>{closedRoads.length}</b> road{closedRoads.length > 1 ? 's' : ''} closed
          </div>
        )}

        {TOOLS.filter(function (t) { return t.kind === 'point'; }).map(function (t) {
          const count = currentMarkers.filter(function (m) { return m.type === t.key; }).length;
          if (count === 0) return null;
          return (
            <div key={t.key} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
              {t.emoji} <b>{count}</b> × {t.label}
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
