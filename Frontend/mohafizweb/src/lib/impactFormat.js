// Pure formatting/derivation logic for prevention-plan impact deltas.
// Kept dependency-free (no React/JSX) so it can be unit tested directly
// with plain `node` (see scripts/test_impact_format.js) and imported by
// PlanWorkspace.js for the actual UI — one implementation, not two that
// can drift out of sync.
//
// Hard convention enforced here: every derived number for a "bad" metric
// (flood %, roads cut, buildings affected) is (before - after), clamped
// to be non-negative, so a positive value ALWAYS means improvement.
// Nothing downstream should ever prepend a literal "-" to these values —
// that produced the exact bug this module exists to prevent (a green
// "improved" badge showing "-0.02%", which reads as a regression).

var PIXEL_AREA_M2 = 795.5;

// Defensive mirror of the backend's hard invariant (see Backend/main.py
// _clamp_after_stats). The backend already clamps, so this should never
// actually fire; it exists so the UI can't show a broken state even if a
// future backend change slips past that clamp.
function deriveImpact(before, after) {
  var keys = ['flooded_percent', 'flooded_pixels', 'roads_cut', 'buildings_affected', 'avg_depth_m', 'max_depth_m'];
  var safeAfter = Object.assign({}, after);
  keys.forEach(function (k) {
    if (before[k] != null && safeAfter[k] != null && safeAfter[k] > before[k]) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[prevention] after.' + k + '=' + safeAfter[k] + ' exceeded before.' + k + '=' + before[k] +
          ' — clamped for display. This should not happen; the backend should already prevent it.');
      }
      safeAfter[k] = before[k];
    }
  });

  var pixelsSaved = Math.max(0, (before.flooded_pixels || 0) - (safeAfter.flooded_pixels || 0));
  var areaSavedM2 = after.area_saved_m2 != null
    ? Math.min(after.area_saved_m2, pixelsSaved * PIXEL_AREA_M2)
    : pixelsSaved * PIXEL_AREA_M2;

  return {
    floodedPercentChange: Math.max(0, Math.round(((before.flooded_percent || 0) - (safeAfter.flooded_percent || 0)) * 100) / 100),
    roadsSaved: Math.max(0, (before.roads_cut || 0) - (safeAfter.roads_cut || 0)),
    buildingsSaved: Math.max(0, (before.buildings_affected || 0) - (safeAfter.buildings_affected || 0)),
    pixelsSaved: pixelsSaved,
    areaSavedM2: Math.round(areaSavedM2),
    hasMeasurableEffect: pixelsSaved > 0 ||
      (before.roads_cut || 0) > (safeAfter.roads_cut || 0) ||
      (before.buildings_affected || 0) > (safeAfter.buildings_affected || 0),
  };
}

// Same convention, for the one place a delta can legitimately go negative:
// a per-action marginal (leave-one-out) contribution, when actions
// overlap. Never a bare sign flip — a genuine regression here is shown as
// a clearly distinct "more flooding" case, not folded into the green flow.
function formatFloodPctDelta(value) {
  var v = value || 0;
  if (v > 0) return { text: v + '% ↓', color: '#059669' };
  if (v < 0) return { text: Math.abs(v) + '% ↑', color: '#d97706' };
  return { text: '—', color: '#94a3b8' };
}

module.exports = {
  deriveImpact: deriveImpact,
  formatFloodPctDelta: formatFloodPctDelta,
  PIXEL_AREA_M2: PIXEL_AREA_M2,
};
