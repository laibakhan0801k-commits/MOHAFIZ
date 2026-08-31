// Regression test: for every prevention-plan display value derived from
// a before/after comparison, "after <= before on a bad metric" must
// render as a clearly positive/improved indicator — never a bare minus
// sign, and never a value that contradicts the sign of a sibling metric
// shown right next to it (the exact bug this guards against: "-0.02%
// flood area" sitting next to "+8,750 m² area saved").
//
// Run with: node scripts/test_impact_format.js

var assert = require('assert');
var path = require('path');
var { deriveImpact, formatFloodPctDelta } = require(path.join(__dirname, '..', 'src', 'lib', 'impactFormat'));

var failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log('[PASS] ' + label);
  } catch (err) {
    failures++;
    console.log('[FAIL] ' + label);
    console.log('  ' + err.message);
  }
}

// --- deriveImpact: normal improvement case -------------------------------
check('deriveImpact: flood area went down 22.61% -> 22.59% renders as a positive reduction, never negative', function () {
  var before = { flooded_percent: 22.61, flooded_pixels: 5000, roads_cut: 139, buildings_affected: 9, avg_depth_m: 3.31, max_depth_m: 15.7 };
  var after = { flooded_percent: 22.59, flooded_pixels: 4989, roads_cut: 139, buildings_affected: 9, avg_depth_m: 3.3, max_depth_m: 15.68, area_saved_m2: 8750 };
  var impact = deriveImpact(before, after);

  assert.ok(impact.floodedPercentChange > 0, 'floodedPercentChange must be positive for an improvement, got ' + impact.floodedPercentChange);
  assert.ok(impact.areaSavedM2 > 0, 'areaSavedM2 must be positive, got ' + impact.areaSavedM2);
  // Both numbers describe the SAME improvement — they must agree in sign.
  assert.strictEqual(Math.sign(impact.floodedPercentChange), Math.sign(impact.areaSavedM2),
    'flood-area delta and area-saved must have the same sign — this is exactly the reported bug');
});

// --- deriveImpact: zero-effect case ---------------------------------------
check('deriveImpact: no change renders as exactly zero on every metric, never negative', function () {
  var before = { flooded_percent: 3.51, flooded_pixels: 2000, roads_cut: 139, buildings_affected: 9, avg_depth_m: 3.31, max_depth_m: 15.7 };
  var after = Object.assign({}, before);
  var impact = deriveImpact(before, after);

  assert.strictEqual(impact.floodedPercentChange, 0);
  assert.strictEqual(impact.roadsSaved, 0);
  assert.strictEqual(impact.buildingsSaved, 0);
  assert.strictEqual(impact.areaSavedM2, 0);
  assert.strictEqual(impact.hasMeasurableEffect, false);
});

// --- deriveImpact: adversarial "after worse than before" -----------------
// Simulates a hypothetical backend regression slipping past the server
// clamp. The client-side mirror must still never show a negative-looking
// "improvement".
check('deriveImpact: after > before (simulated backend regression) is clamped to zero, not negative', function () {
  var before = { flooded_percent: 3.51, flooded_pixels: 2000, roads_cut: 139, buildings_affected: 9, avg_depth_m: 3.31, max_depth_m: 15.7 };
  var after = { flooded_percent: 3.52, flooded_pixels: 2001, roads_cut: 140, buildings_affected: 10, avg_depth_m: 3.32, max_depth_m: 15.71 };
  var impact = deriveImpact(before, after);

  assert.ok(impact.floodedPercentChange >= 0, 'floodedPercentChange must never go negative, got ' + impact.floodedPercentChange);
  assert.ok(impact.roadsSaved >= 0, 'roadsSaved must never go negative, got ' + impact.roadsSaved);
  assert.ok(impact.buildingsSaved >= 0, 'buildingsSaved must never go negative, got ' + impact.buildingsSaved);
  assert.ok(impact.areaSavedM2 >= 0, 'areaSavedM2 must never go negative, got ' + impact.areaSavedM2);
  assert.strictEqual(impact.hasMeasurableEffect, false, 'a plan that made nothing measurably better must not claim an effect');
});

// --- formatFloodPctDelta: sign convention for the marginal (per-action) case
check('formatFloodPctDelta: positive value (action helped) never renders a bare minus sign', function () {
  var r = formatFloodPctDelta(0.05);
  assert.ok(r.text.indexOf('-') === -1, 'text must not contain a bare minus, got "' + r.text + '"');
  assert.strictEqual(r.color, '#059669', 'a positive (improved) delta must render in the "good" color');
});

check('formatFloodPctDelta: negative value (rare overlap artifact) is shown as a distinct, clearly-worse indicator', function () {
  var r = formatFloodPctDelta(-0.03);
  assert.strictEqual(r.text, '0.03% ↑', 'a genuine regression must show its magnitude with an unambiguous "more flooding" marker');
  assert.strictEqual(r.color, '#d97706', 'a regression must render in a distinct warning color, not green');
});

check('formatFloodPctDelta: zero renders as a neutral dash, not "0%" that could be misread as a tiny negative', function () {
  var r = formatFloodPctDelta(0);
  assert.strictEqual(r.text, '—');
  assert.strictEqual(r.color, '#94a3b8');
});

if (failures > 0) {
  console.log('\nFAILED: ' + failures + ' assertion(s) failed.');
  process.exit(1);
}
console.log('\nPASSED: all impact-format invariants hold.');
