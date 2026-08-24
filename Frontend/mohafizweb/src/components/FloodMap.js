'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const BBOX = {
  north: 33.7350,
  south: 33.6700,
  east: 73.0850,
  west: 73.0100,
};

const TARGET_VIEW = {
  center: [(BBOX.east + BBOX.west) / 2, (BBOX.north + BBOX.south) / 2],
  zoom: 15,
  pitch: 55,
  bearing: -20,
};

export default function FloodMap() {
  const mapContainer = useRef(null);
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
  });

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
        [BBOX.west, BBOX.south],
        [BBOX.east, BBOX.north],
      ],
      minZoom: 12,
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

        setStatus('all layers loaded ✓');
      } catch (err) {
        setStatus('ERROR: ' + err.message);
      }
    });
  }, []);

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

  const LAYER_LIST = [
    { key: 'hospitals', label: 'Hospitals (42)', color: '#dc2626' },
    { key: 'shelters', label: 'Schools / shelters', color: '#facc15' },
    { key: 'water', label: 'Nullah Leh + water', color: '#0284c7' },
    { key: 'greenery', label: 'Green spaces', color: '#4ade80' },
    { key: 'buildings', label: 'Buildings (3D)', color: '#94a3b8' },
    { key: 'base', label: 'Base map', color: '#94a3b8' },
  ];

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

      <button
        onClick={viewWholeCorridor}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 999,
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
        Whole corridor
      </button>

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}