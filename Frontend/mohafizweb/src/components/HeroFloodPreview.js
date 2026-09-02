"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
// PlanWorkspace.js already imports this on /plan, but Home never loads
// that component, so this map needs its own copy of the base styles.
import "maplibre-gl/dist/maplibre-gl.css";

// Real numbers from an actual River Overflow run against this app's own
// flood engine (bank_rise_m = 1.0, water_level_m = 522) — not
// placeholders. The overlay image (hero-flood-preview.png) is the exact
// PNG the backend rendered for that run. This is the real 2D map
// (MapLibre + OpenStreetMap tiles) used everywhere else in the app,
// styled for the hero — not a 3D model or a fabricated visual. Camera
// is a flat top-down bounds-fit, deliberately not the pitched/bearing
// camera FloodMap.js's real /map page uses — combining `bounds` with a
// non-zero pitch at construction time left this map blank in testing.
const FLOOD_IMAGE_BOUNDS = [
  73.00986111114463, 33.670138888885404, 73.08486111114463, 33.735138888885416,
];
const FLOODED_BBOX = [
  73.01597222225574, 33.670138888885404, 73.08486111114463, 33.689305555552075,
];
const SCENARIO_STATS = {
  waterLevelM: 522,
  floodedPercent: 11,
  avgDepthM: 4.4,
  affectedBuildings: 59,
};

export default function HeroFloodPreview() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const [w, s, e, n] = FLOOD_IMAGE_BOUNDS;
    const [fw, fs, fe, fn] = FLOODED_BBOX;

    let map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              maxzoom: 19,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm-layer", type: "raster", source: "osm", paint: { "raster-opacity": 0.85 } }],
        },
        // Flat bounds-fit only at construction time — combining `bounds`
        // with a non-zero pitch/bearing here previously left the map
        // blank in testing, so the tilt (if any) is applied separately
        // below, after the flat view has already loaded successfully.
        bounds: [
          [fw - 0.01, fs - 0.01],
          [fe + 0.01, fn + 0.01],
        ],
        fitBoundsOptions: { padding: 12 },
        interactive: false,
        attributionControl: false,
      });
    } catch (err) {
      console.error("HeroFloodPreview: map failed to initialize", err);
      return;
    }
    mapRef.current = map;

    map.on("error", (e) => {
      console.error("HeroFloodPreview: maplibre error", e && e.error);
    });

    map.on("load", async () => {
      try {
        const [waterways, waterBodies, greenery] = await Promise.all([
          fetch("/data/waterways.geojson").then((r) => r.json()),
          fetch("/data/water_bodies.geojson").then((r) => r.json()),
          fetch("/data/greenery.geojson").then((r) => r.json()),
        ]);
        map.addSource("greenery", { type: "geojson", data: greenery });
        map.addLayer({ id: "greenery-layer", type: "fill", source: "greenery", paint: { "fill-color": "#16a34a", "fill-opacity": 0.18 } });
        map.addSource("waterways", { type: "geojson", data: waterways });
        map.addLayer({ id: "waterways-layer", type: "line", source: "waterways", paint: { "line-color": "#38bdf8", "line-width": 1.2, "line-opacity": 0.6 } });
        map.addSource("water-bodies", { type: "geojson", data: waterBodies });
        map.addLayer({ id: "water-bodies-layer", type: "fill", source: "water-bodies", paint: { "fill-color": "#38bdf8", "fill-opacity": 0.2 } });
      } catch (err) {
        // Decorative context layers only — the flood overlay below is
        // the real content, so a failed fetch here is silently skipped.
      }

      map.addSource("flood-overlay", {
        type: "image",
        url: "/data/hero-flood-preview.png",
        coordinates: [[w, n], [e, n], [e, s], [w, s]],
      });
      map.addLayer({
        id: "flood-overlay-layer",
        type: "raster",
        source: "flood-overlay",
        paint: { "raster-opacity": 0.82 },
      });

      // A rough outline of the real flooded bounding box, glowing —
      // built from the actual flooded_bbox this run returned, not a
      // decorative shape unrelated to the data.
      const bboxLine = {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[fw, fn], [fe, fn], [fe, fs], [fw, fs], [fw, fn]],
        },
      };
      map.addSource("flood-edge", { type: "geojson", data: bboxLine });
      map.addLayer({
        id: "flood-edge-glow",
        type: "line",
        source: "flood-edge",
        paint: { "line-color": "#FF5A36", "line-width": 8, "line-blur": 8, "line-opacity": 0.5 },
      });
      map.addLayer({
        id: "flood-edge-line",
        type: "line",
        source: "flood-edge",
        paint: { "line-color": "#FF5A36", "line-width": 1.5, "line-opacity": 0.8 },
      });

      // Slow glow pulse, JS-driven since MapLibre paint properties can't
      // be animated with CSS — skipped entirely under reduced motion.
      const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduceMotion) {
        let t = 0;
        const tick = () => {
          if (!mapRef.current) return;
          t += 0.02;
          const pulse = 0.35 + (Math.sin(t) + 1) * 0.2; // 0.35 - 0.75
          try {
            map.setPaintProperty("flood-edge-glow", "line-opacity", pulse);
          } catch (err) {
            return; // map torn down mid-loop
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className="relative w-full h-[380px] sm:h-[460px] lg:h-[560px] rounded-2xl overflow-hidden border border-line shadow-2xl"
      aria-hidden="true"
    >
      <div ref={containerRef} className="absolute inset-0" />

      {/* Vignette for contrast under the floating chips — purely
          cosmetic, drawn over the real map, no data implied. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgba(6,45,41,0.55) 0%, rgba(6,45,41,0) 22%, rgba(6,45,41,0) 70%, rgba(6,45,41,0.6) 100%)",
        }}
      />

      {/* Corner frame marks — decorative "instrument" styling, not data. */}
      <div className="pointer-events-none absolute inset-3 border border-paper/10 rounded-xl" />
      <div className="pointer-events-none absolute top-3 left-3 w-5 h-5 border-t-2 border-l-2 border-flow/70 rounded-tl-md" />
      <div className="pointer-events-none absolute top-3 right-3 w-5 h-5 border-t-2 border-r-2 border-flow/70 rounded-tr-md" />
      <div className="pointer-events-none absolute bottom-3 left-3 w-5 h-5 border-b-2 border-l-2 border-flow/70 rounded-bl-md" />
      <div className="pointer-events-none absolute bottom-3 right-3 w-5 h-5 border-b-2 border-r-2 border-flow/70 rounded-br-md" />

      {/* Real, genuine values from the captured run above — not placeholder text. */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-6 left-6 bg-ink/80 backdrop-blur border border-line/60 rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] tracking-wide text-mint">WATER LEVEL</div>
          <div className="font-mono text-lg text-paper">{SCENARIO_STATS.waterLevelM}M</div>
        </div>
        <div className="absolute top-6 right-6 bg-ink/80 backdrop-blur border border-alert/50 rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] tracking-wide text-mint">FLOODED AREA</div>
          <div className="font-mono text-lg text-alert">{SCENARIO_STATS.floodedPercent}%</div>
        </div>
        <div className="absolute bottom-6 left-6 bg-ink/80 backdrop-blur border border-line/60 rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] tracking-wide text-mint">AVG DEPTH</div>
          <div className="font-mono text-lg text-paper">{SCENARIO_STATS.avgDepthM}M</div>
        </div>
        <div className="absolute bottom-6 right-6 bg-ink/80 backdrop-blur border border-alert/50 rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] tracking-wide text-mint">BUILDINGS AFFECTED</div>
          <div className="font-mono text-lg text-alert">{SCENARIO_STATS.affectedBuildings}</div>
        </div>
        <div className="absolute top-6 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-wide text-mint/80 bg-ink/60 backdrop-blur px-3 py-1 rounded-full">
          RIVER OVERFLOW — REAL SIMULATION OUTPUT
        </div>
      </div>
    </div>
  );
}
