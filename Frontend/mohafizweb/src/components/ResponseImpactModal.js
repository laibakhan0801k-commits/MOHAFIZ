'use client';

import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';

// ---------------------------------------------------------------------
// ResponseImpactModal — reusable "Response Impact Report" popup.
//
// Styled to match the existing Prevention Impact Report exactly (same
// overlay/card chrome, same before/after two-panel map layout, same
// stat-row and button treatment) but built for a different question:
// prevention measures how much LESS gets flooded, response measures how
// much of a FIXED flood's risk is actually covered by the plan's pins.
//
// This component only renders what it is handed — every number, every
// map layer and the verdict text are computed by the caller (see
// buildRiverOverflowResponseImpact / buildRainfallResponseImpact in
// PlanWorkspace.js, which each reuse the exact same hazard/buildings/
// roads data their scenario's own response-action validators already
// read). That split is what lets each new scenario — and later phases —
// reuse this component with a different metric set: they only need to
// build a differently-shaped `result` object, not a new modal.
//
// Expected `result` shape:
// {
//   summaryLine: string,  // one plain-text context line, e.g. "📍 1,234
//                         // buildings (~8,021 people) inside the flood
//                         // extent — ..." — fully composed by the caller
//                         // since what's being counted (buildings, area,
//                         // points) differs per scenario.
//   before: { statRows: [{ value, suffix }], mapOverlay: { roads, circles, points } },
//   after:  { statRows: [{ value, suffix }], mapOverlay: { roads, circles, points } },
//   verdict: { text, tone: 'good'|'warn'|'bad'|'neutral' },
// }
// mapOverlay.roads/circles/points are GeoJSON FeatureCollections.
// circles and points carry a `properties.color` used to paint them.
// roads carries a `properties.closed` (bool) per feature and doubles as
// a generic "at-risk segment/area" layer — its features can be
// LineStrings, Points or Polygons (or a mix); addOverlayLayers below
// adds a line, a circle AND a fill treatment for it, and MapLibre
// silently skips whichever don't match a given feature's geometry type,
// so the same overlay works for flooded road LineStrings (river
// overflow), low-point markers (rainfall) or drainage-risk zone
// Polygons (drainage failure) without this component knowing which.
// ---------------------------------------------------------------------

const VERDICT_COLORS = {
  good: { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  warn: { bg: '#fffbeb', border: '#fde68a', text: '#92400e' },
  bad: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' },
  neutral: { bg: '#f8fafc', border: '#e2e8f0', text: '#64748b' },
};

function addOverlayLayers(map, scenario, overlay) {
  if (scenario && scenario.flood_image && scenario.flood_image_bounds) {
    const w = scenario.flood_image_bounds[0], s = scenario.flood_image_bounds[1];
    const e = scenario.flood_image_bounds[2], n = scenario.flood_image_bounds[3];
    map.addSource('flood-raster', {
      type: 'image',
      url: scenario.flood_image,
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    });
    map.addLayer({ id: 'flood-raster-layer', type: 'raster', source: 'flood-raster', paint: { 'raster-opacity': 0.55 } });
  }

  // line-dasharray cannot be a data (feature) expression in MapLibre, so
  // open/closed roads are split into two layers rather than one
  // data-driven one. A line, a circle AND a fill layer are added for
  // each — a layer simply renders nothing for geometry types it doesn't
  // apply to, so this one overlay works whether the scenario's at-risk
  // segments are LineStrings (river overflow's flooded roads), Points
  // (rainfall's low-point/underpass markers, drainage failure's overflow
  // junctions) or Polygons (drainage failure's risk-zone areas) without
  // the modal needing to know which. Fill layers are added first so
  // lines/points/circles drawn after them sit on top, not underneath a
  // filled area.
  map.addSource('impact-roads', { type: 'geojson', data: overlay.roads });
  map.addLayer({
    id: 'impact-roads-open-fill',
    type: 'fill',
    source: 'impact-roads',
    filter: ['!=', ['get', 'closed'], true],
    paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.16 },
  });
  map.addLayer({
    id: 'impact-roads-closed-fill',
    type: 'fill',
    source: 'impact-roads',
    filter: ['==', ['get', 'closed'], true],
    paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.16 },
  });
  map.addLayer({
    id: 'impact-roads-open-line',
    type: 'line',
    source: 'impact-roads',
    filter: ['!=', ['get', 'closed'], true],
    paint: { 'line-color': '#dc2626', 'line-width': 3 },
  });
  map.addLayer({
    id: 'impact-roads-closed-line',
    type: 'line',
    source: 'impact-roads',
    filter: ['==', ['get', 'closed'], true],
    paint: { 'line-color': '#16a34a', 'line-width': 3, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'impact-roads-open-point',
    type: 'circle',
    source: 'impact-roads',
    filter: ['!=', ['get', 'closed'], true],
    paint: { 'circle-radius': 4, 'circle-color': '#dc2626', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
  });
  map.addLayer({
    id: 'impact-roads-closed-point',
    type: 'circle',
    source: 'impact-roads',
    filter: ['==', ['get', 'closed'], true],
    paint: { 'circle-radius': 4, 'circle-color': '#16a34a', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
  });

  map.addSource('impact-circles', { type: 'geojson', data: overlay.circles });
  map.addLayer({
    id: 'impact-circles-fill',
    type: 'fill',
    source: 'impact-circles',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 },
  });
  map.addLayer({
    id: 'impact-circles-outline',
    type: 'line',
    source: 'impact-circles',
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7 },
  });

  map.addSource('impact-points', { type: 'geojson', data: overlay.points });
  map.addLayer({
    id: 'impact-points-layer',
    type: 'circle',
    source: 'impact-points',
    paint: {
      'circle-radius': 5,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  });
}

// One shared bounding box for both maps (padded), built from the flood
// raster plus every circle/point in the AFTER overlay — the after
// overlay is always the superset, so before/after stay on the same
// camera for a fair side-by-side comparison.
function computeSharedBounds(scenario, afterOverlay) {
  const pad = 0.004;
  let w, s, e, n;
  if (scenario && scenario.flooded_bbox) {
    w = scenario.flooded_bbox[0]; s = scenario.flooded_bbox[1];
    e = scenario.flooded_bbox[2]; n = scenario.flooded_bbox[3];
  } else if (scenario && scenario.flood_image_bounds) {
    w = scenario.flood_image_bounds[0]; s = scenario.flood_image_bounds[1];
    e = scenario.flood_image_bounds[2]; n = scenario.flood_image_bounds[3];
  } else {
    return null;
  }

  const extra = [];
  if (afterOverlay.circles && afterOverlay.circles.features.length > 0) extra.push(afterOverlay.circles);
  if (afterOverlay.points && afterOverlay.points.features.length > 0) extra.push(afterOverlay.points);
  extra.forEach(function (fc) {
    try {
      const bbox = turf.bbox(fc);
      w = Math.min(w, bbox[0]); s = Math.min(s, bbox[1]);
      e = Math.max(e, bbox[2]); n = Math.max(n, bbox[3]);
    } catch (err) {
      // empty/invalid collection — skip
    }
  });

  return [[w - pad, s - pad], [e + pad, n + pad]];
}

export default function ResponseImpactModal({ scenario, result, onSeeFullReport, onClose }) {
  const beforeContainer = useRef(null);
  const afterContainer = useRef(null);
  const beforeMapRef = useRef(null);
  const afterMapRef = useRef(null);

  useEffect(() => {
    if (!result) return;
    if (!beforeContainer.current || !afterContainer.current) return;

    const bounds = computeSharedBounds(scenario, result.after.mapOverlay);

    function makeMap(container, overlay) {
      const m = new maplibregl.Map({
        container: container,
        style: {
          version: 8,
          sources: { 'osm': { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
          layers: [{ id: 'osm-layer', type: 'raster', source: 'osm' }],
        },
        bounds: bounds || undefined,
        fitBoundsOptions: { padding: 20 },
        interactive: true,
      });
      m.on('load', function () { addOverlayLayers(m, scenario, overlay); });
      return m;
    }

    if (beforeMapRef.current) { beforeMapRef.current.remove(); beforeMapRef.current = null; }
    if (afterMapRef.current) { afterMapRef.current.remove(); afterMapRef.current = null; }

    const bm = makeMap(beforeContainer.current, result.before.mapOverlay);
    const am = makeMap(afterContainer.current, result.after.mapOverlay);
    beforeMapRef.current = bm;
    afterMapRef.current = am;

    let syncing = false;
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

    return function () {
      if (beforeMapRef.current) { beforeMapRef.current.remove(); beforeMapRef.current = null; }
      if (afterMapRef.current) { afterMapRef.current.remove(); afterMapRef.current = null; }
    };
  }, [result, scenario]);

  if (!result) return null;

  const verdictColors = VERDICT_COLORS[result.verdict.tone] || VERDICT_COLORS.neutral;

  return (
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
      onClick={onClose}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>
            🚨 Response Impact Report
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 16, padding: '0 2px' }}>
          {result.summaryLine}
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>Before (no plan)</div>
            <div ref={beforeContainer} style={{ width: '100%', height: 200, borderRadius: 10, border: '1px solid #fecaca', marginBottom: 8, overflow: 'hidden' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#059669', marginBottom: 8 }}>After (with plan)</div>
            <div ref={afterContainer} style={{ width: '100%', height: 200, borderRadius: 10, border: '1px solid #bbf7d0', marginBottom: 8, overflow: 'hidden' }} />
          </div>
        </div>

        {/* One before -> after table instead of the same five sentences
            printed under each map. Every number is the backend's own
            coverage figure; this only pairs the two columns up so the
            change is readable at a glance. Rows carrying only the old
            {value, suffix} shape (saved plans from before this) still
            render, via the fallbacks below. */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
          {result.before.statRows.map(function (b, i) {
            const a = result.after.statRows[i] || b;
            const hasPct = typeof b.pct === 'number' && typeof a.pct === 'number';
            const delta = hasPct ? a.pct - b.pct : null;
            const improved = delta !== null && delta > 0;
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px', fontSize: 12,
                  background: i % 2 ? '#f8fafc' : 'white',
                  borderTop: i ? '1px solid #eef2f6' : 'none',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: '#0f172a' }}>
                    {a.label || a.suffix}
                  </div>
                  {a.detail && (
                    <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 1 }}>{a.detail}</div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#94a3b8', fontWeight: 700 }}>{b.value}</span>
                  <span style={{ color: '#cbd5e1' }}>&rarr;</span>
                  <span style={{ fontSize: 16, fontWeight: 900, color: improved ? '#059669' : '#475569' }}>
                    {a.value}
                  </span>
                  {improved && (
                    <span style={{
                      fontSize: 10, fontWeight: 800, color: '#059669',
                      background: '#dcfce7', borderRadius: 999, padding: '2px 6px',
                    }}>
                      +{delta}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{
          background: verdictColors.bg,
          border: '1px solid ' + verdictColors.border,
          borderRadius: 12,
          padding: 12,
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 700,
          color: verdictColors.text,
          marginBottom: 8,
        }}>
          {result.verdict.text}
        </div>

        <div style={{ fontSize: 9, color: '#64748b', marginBottom: 16, padding: '0 4px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 2, background: '#dc2626', display: 'inline-block' }} /> still at risk / untreated
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 2, background: '#16a34a', display: 'inline-block' }} /> handled by this plan
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 9, background: '#7c3aed', display: 'inline-block' }} /> shaded = coverage from placed actions
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onSeeFullReport}
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
            }}
          >
            See full impact report →
          </button>
          <button
            onClick={onClose}
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
  );
}
