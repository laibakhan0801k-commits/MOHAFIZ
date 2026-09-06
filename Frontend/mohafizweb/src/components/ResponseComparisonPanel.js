'use client';

// Dark green + lime tokens, matching PreventionPlanPanel.js and the
// site-wide palette in tailwind.config.js exactly.
const T = {
  ink: '#062D29',
  surface: '#0A3D37',
  surface2: '#0E4A43',
  paper: '#F2F8F5',
  mint: '#DCEFE9',
  flow: '#C7FF28',
  alert: '#FF5A36',
  line: '#3E5C56',
};

// Every scenario's real response actions, with the SAME emoji/label the
// manual tool list uses for each. Previously this held river overflow's
// five only, so a rainfall/drainage/dam proposal rendered as a bare
// "✨ drainBlockageClearance" -- the internal key, shown to the user.
const ACTION_META = {
  // river_overflow
  warningPoint: { emoji: '📢', label: 'Warning announcement point' },
  evacuationZone: { emoji: '⚠️', label: 'Priority evacuation zone' },
  closeRoad: { emoji: '🚧', label: 'Road closure & diversion point' },
  boatLaunch: { emoji: '🛟', label: 'Boat launch point' },
  reliefMedicalPost: { emoji: '🏕️', label: 'Relief camp / medical post' },
  // rainfall
  rainWarning: { emoji: '📢', label: 'Warning announcement point' },
  rainEvacZone: { emoji: '⚠️', label: 'Priority evacuation zone' },
  rainRoadClosure: { emoji: '🚧', label: 'Road closure & diversion' },
  rainWaterRescue: { emoji: '🛟', label: 'Water rescue staging point' },
  rainMedicalPost: { emoji: '🚑', label: 'Medical / first-aid post' },
  rainReliefCamp: { emoji: '🏕️', label: 'Relief camp / shelter' },
  // drainage_failure
  drainBlockageClearance: { emoji: '🧹', label: 'Blockage / debris clearance point' },
  drainPumpDeployment: { emoji: '🚜', label: 'Emergency drainage crew / pump deployment' },
  drainSewerOverflow: { emoji: '☣️', label: 'Sewer / manhole overflow marker' },
  drainVectorControl: { emoji: '🦟', label: 'Standing water / vector-control point' },
  drainBypass: { emoji: '↪️', label: 'Temporary diversion / bypass point' },
  // dam_release
  damReleaseTracking: { emoji: '📊', label: 'Release-rate tracking point' },
  damWarningPoint: { emoji: '⏱️', label: 'Dam-release warning point' },
  damEvacZone: { emoji: '🌊', label: 'Time-tiered evacuation zone' },
  damCrossingClosure: { emoji: '🌉', label: 'Bridge / crossing closure point' },
  damRallyPoint: { emoji: '🏔️', label: 'High-ground rally point' },
};

// Every number this component renders comes from a real backend response
// (Backend/main.py's /ai/response/compare -- the Hazard Reader,
// Strategist, and Impact Evaluator agents) or the real validated_payload
// on each proposal. Nothing here is invented client-side.
// Depths arrive as raw float subtraction (water level minus ground
// elevation), so a real value showed in the UI as
// "12.799999999999955m max depth in zone". One decimal is already
// finer than the DEM's own vertical accuracy.
function fmtDepth(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n * 10) / 10 : v;
}

export default function ResponseComparisonPanel(props) {
  var loading = props.aiResponseLoading;
  var result = props.aiResponseResult;
  var error = props.aiResponseError;
  var onRun = props.onRun;
  var onAddProposal = props.onAddProposal;
  var onApplyFullPlan = props.onApplyFullPlan;
  var onDismiss = props.onDismiss;
  var addedProposalKeys = props.addedProposalKeys || {};

  var proposals = (result && result.proposals) || [];
  var trace = (result && result.trace) || [];
  var comparison = result && result.comparison;
  // Real zone breakdown / confidence / totals, computed server-side by
  // Backend/ai_plan_summary.py from the real layers -- never asked of
  // the model. See that module for what it deliberately does NOT
  // compute (lives saved, minutes saved, damage %) and why.
  var planSummary = result && result.plan_summary;

  var RISK_COLOR = {
    critical: T.alert,
    high: '#FF8A3D',
    medium: '#E8C547',
    low: T.flow,
  };

  var reasoningSummary = null;
  if (proposals.length > 0) {
    var withReasoning = proposals.filter(function (p) { return p.ai_reasoning; });
    if (withReasoning.length > 0) reasoningSummary = withReasoning[0].ai_reasoning;
  }
  // Must build the key EXACTLY as the card below does (index included),
  // or "all added" can never become true and the Apply-all button never
  // settles into its done state.
  var proposalKeyFor = function (p, i) {
    return p.action_type + '_' + p.location.lon.toFixed(6) + '_' + p.location.lat.toFixed(6) + '_' + i;
  };
  var allAdded = proposals.length > 0 && proposals.every(function (p, i) {
    return !!addedProposalKeys[proposalKeyFor(p, i)];
  });

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid ' + T.line, paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.paper, marginBottom: 2 }}>
        ✨ AI Response Plan
      </div>
      <div style={{ fontSize: 10.5, color: T.mint, opacity: 0.8, marginBottom: 8 }}>
        Reads this simulation and your current plan, proposes real coverage for what&apos;s still exposed, then shows a real before/after.
      </div>

      <button
        onClick={onRun}
        disabled={loading}
        style={{
          width: '100%', padding: '10px', borderRadius: 11, border: 'none',
          background: loading ? T.line : T.flow, color: loading ? T.mint : T.ink,
          fontWeight: 800, fontSize: 12.5, cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.85 : 1,
        }}
      >
        {loading ? 'Analyzing this simulation…' : (result ? '↻ Regenerate' : '✨ Generate AI Response Plan')}
      </button>

      {loading && (
        <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: T.ink, border: '1px solid ' + T.line, color: T.mint, fontSize: 10, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7 }}>
          Running the Hazard Reader and Strategist against this simulation…
        </div>
      )}

      {error && !loading && (
        <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 10.5, fontWeight: 600, lineHeight: 1.4 }}>
          {error}
          <button
            onClick={onRun}
            style={{ display: 'block', marginTop: 8, width: '100%', padding: '6px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      )}

      {result && !loading && (
        <div style={{ marginTop: 10 }}>
          <div style={{ padding: 9, borderRadius: 10, background: T.ink, color: T.mint, fontSize: 10, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7, marginBottom: 10, maxHeight: 160, overflowY: 'auto' }}>
            <div style={{ opacity: 0.7 }}>
              {result.hazard_summary.uncovered_zones.length} of {result.hazard_summary.priority_zones.length} priority zone
              {result.hazard_summary.priority_zones.length === 1 ? '' : 's'} not yet covered by your plan.
            </div>
            {trace.length === 0 && (
              <div style={{ color: T.alert }}>No priority zones could be analyzed — see error above, or try again.</div>
            )}
            {trace.map(function (ev, i) {
              if (ev.event === 'zone_start') {
                return <div key={i} style={{ color: T.flow, marginTop: 4 }}>🎯 Zone {ev.zone_index + 1}: {ev.zone_description}</div>;
              }
              if (ev.event === 'action_type_start') {
                return <div key={i}>&nbsp;&nbsp;Trying {ev.action_type}…</div>;
              }
              if (ev.event === 'no_candidates') {
                return <div key={i} style={{ opacity: 0.6 }}>&nbsp;&nbsp;No real candidate points found for {ev.action_type} here.</div>;
              }
              if (ev.event === 'rejected') {
                return <div key={i} style={{ color: T.alert }}>&nbsp;&nbsp;✗ Rejected — {ev.reason}. Retrying…</div>;
              }
              if (ev.event === 'llm_unreachable') {
                return <div key={i} style={{ color: T.alert }}>&nbsp;&nbsp;⚠️ AI call failed — trying a different action type.</div>;
              }
              if (ev.event === 'accepted') {
                return <div key={i} style={{ color: T.flow }}>&nbsp;&nbsp;✓ {ev.action_type} — validated against real placement rules</div>;
              }
              if (ev.event === 'zone_skipped') {
                return <div key={i} style={{ opacity: 0.6 }}>&nbsp;&nbsp;No valid action found for this zone.</div>;
              }
              return null;
            })}
          </div>

          {proposals.length === 0 && trace.length > 0 && (
            <div style={{ padding: 9, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#64748b', fontSize: 10.5, lineHeight: 1.4 }}>
              No proposal passed real validation this run — every candidate the AI tried was rejected (see the log above), or none existed for these zones. This is an honest &ldquo;nothing to add,&rdquo; not an error.
            </div>
          )}

          {reasoningSummary && (
            <div style={{ padding: 9, borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', fontSize: 10.5, fontWeight: 600, lineHeight: 1.4, marginBottom: 8 }}>
              💭 {reasoningSummary}
            </div>
          )}

          {/* Real before/after -- one function (Impact Evaluator), called
              once against your current plan and once against your plan
              plus these proposals, so the two columns can never drift. */}
          {comparison && (
            <div style={{ marginBottom: 8 }}>
              {(function () {
                // Row wording comes from the backend, per scenario
                // (ai_response_evaluator.ROW_LABELS_BY_CAUSE). These
                // five keys are shared across all four scenarios but do
                // not measure the same things -- "roads" is flood-cut
                // roads for a river overflow and channel crossings for
                // a dam release. One hard-coded wording mislabelled
                // three scenarios out of four.
                var L = (result && result.row_labels) || {};
                return [
                { label: (L.evacuation === null ? null : (L.evacuation || 'Evacuation coverage')), before: comparison.before.evacuation.percent, after: comparison.after.evacuation.percent, unit: '%' },
                { label: (L.roads === null ? null : (L.roads || 'Flood-cut roads barricaded')), before: comparison.before.roads.percent, after: comparison.after.roads.percent, unit: '%' },
                { label: (L.rescue === null ? null : (L.rescue || 'Rescue-staging coverage')), before: comparison.before.rescue.percent, after: comparison.after.rescue.percent, unit: '%' },
                { label: (L.relief === null ? null : (L.relief || 'Relief/medical coverage')), before: comparison.before.relief.percent, after: comparison.after.relief.percent, unit: '%' },
                { label: (L.warning === null ? null : (L.warning || 'Warning coverage')), before: comparison.before.warning.percent, after: comparison.after.warning.percent, unit: '%' },
                // A row whose label is explicitly null does not apply to
                // this scenario (dam release has no relief/medical
                // action, and its percent is hard-coded 0), so drop it
                // rather than show a permanent 0% that reads as failure.
                ].filter(function (r) { return r.label !== null && r.label !== undefined; });
              })().map(function (row, i) {
                var improved = row.after > row.before;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 2px', fontSize: 10.5 }}>
                    <span style={{ color: T.mint, opacity: 0.8 }}>{row.label}</span>
                    <span style={{ fontWeight: 700, color: improved ? T.flow : T.paper }}>
                      {row.before}{row.unit} → {row.after}{row.unit}
                      {improved && <span style={{ marginLeft: 4, color: T.flow }}>▲</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* PLAN COVERAGE SCORE. Deliberately NOT called "confidence":
              this measures how thoroughly the plan covers the risk that
              was identified, not how likely it is to succeed -- there is
              no model here that could honestly claim the latter. The
              score is only ever shown WITH its three factors, because
              each factor is a real measurement that can be checked,
              while the weighting that blends them into one number is a
              design choice. Number alone would be indefensible. */}
          {planSummary && planSummary.confidence && (
            <div style={{ marginBottom: 8, padding: 10, borderRadius: 11, background: T.surface2, border: '1px solid ' + T.line }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.paper }}>Plan Coverage Score</span>
                <span style={{ fontSize: 18, fontWeight: 800, color: T.flow }}>{planSummary.confidence.score}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 4, background: T.ink, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ width: planSummary.confidence.score + '%', height: '100%', background: T.flow }} />
              </div>
              {(planSummary.confidence.factors || []).map(function (f, i) {
                return (
                  <div key={i} style={{ marginBottom: 5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
                      <span style={{ color: T.mint }}>{f.label}</span>
                      <span style={{ color: T.paper, fontWeight: 700 }}>{f.value}</span>
                    </div>
                    <div style={{ fontSize: 9.5, color: T.mint, opacity: 0.65, lineHeight: 1.35 }}>{f.detail}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* OVERALL IMPACT -- real totals only. The reference design's
              "lives saved / time saved / damage reduced" are not here on
              purpose: this project has no mortality, evacuation-timing
              or asset-value model, so those numbers could only be
              invented. These are their measurable equivalents. */}
          {planSummary && planSummary.overall && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {[
                { label: 'Buildings covered', value: planSummary.overall.buildings_covered + ' / ' + planSummary.overall.buildings_at_risk },
                { label: 'People reached', value: '≈' + planSummary.overall.people_in_covered_buildings },
                { label: 'Zones addressed', value: planSummary.overall.zones_addressed + ' / ' + planSummary.overall.zones_total },
              ].map(function (tile, i) {
                return (
                  <div key={i} style={{ flex: 1, padding: '7px 8px', borderRadius: 10, background: T.ink, border: '1px solid ' + T.line }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: T.flow }}>{tile.value}</div>
                    <div style={{ fontSize: 9, color: T.mint, opacity: 0.75, marginTop: 1 }}>{tile.label}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* PLAN BY ZONE -- every zone the Hazard Reader really found,
              with its measured exposure and the real actions placed in
              it. A zone with no actions is shown as such rather than
              hidden, so the plan's gaps stay visible. */}
          {planSummary && (planSummary.zones || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: T.paper, marginBottom: 5 }}>Plan by zone</div>
              {planSummary.zones.map(function (z) {
                var color = RISK_COLOR[z.risk_level] || T.mint;
                return (
                  <div key={z.zone_index} style={{ marginBottom: 6, padding: 9, borderRadius: 11, background: T.surface2, border: '1px solid ' + T.line, borderLeft: '3px solid ' + color }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, color: T.paper }}>Zone {z.zone_index + 1}</span>
                      <span style={{ fontSize: 9, fontWeight: 800, color: color, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                        {z.risk_level}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: T.mint, opacity: 0.85, marginTop: 3, lineHeight: 1.35 }}>
                      {z.description}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 10, color: T.mint }}>
                      <span>🏚️ <b style={{ color: T.paper }}>{z.buildings_at_risk}</b> buildings</span>
                      <span>👥 <b style={{ color: T.paper }}>≈{z.population_at_risk}</b></span>
                      <span>💧 <b style={{ color: T.paper }}>{z.max_depth_m}m</b> max</span>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      {z.actions.length === 0 ? (
                        <div style={{ fontSize: 10, color: T.alert, fontWeight: 700 }}>
                          ⚠ No action placed here — this zone is still uncovered
                        </div>
                      ) : (
                        z.actions.map(function (a, ai) {
                          var meta = ACTION_META[a.action_type] || { emoji: '✨', label: a.action_type };
                          var cov = a.real_coverage || {};
                          return (
                            <div key={ai} style={{ marginTop: 4 }}>
                              <div style={{ fontSize: 10, color: T.paper, fontWeight: 700 }}>
                                ✅ {meta.emoji} {meta.label}
                                {cov.buildings_covered !== undefined && (
                                  <span style={{ color: T.flow, marginLeft: 5 }}>
                                    covers {cov.buildings_covered} buildings
                                  </span>
                                )}
                              </div>
                              {a.reasoning && (
                                <div style={{ fontSize: 9.5, color: T.mint, opacity: 0.8, fontStyle: 'italic', lineHeight: 1.35, marginTop: 1 }}>
                                  {a.reasoning}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {proposals.map(function (p, i) {
            // Index included so two proposals that validate to the same
              // point can never collide: React needs a unique key, and
              // this same string keys addedProposalKeys -- a shared key
              // made "Add to plan" mark both cards as added while only
              // one marker was created. The backend also drops such
              // duplicates now; this is the belt-and-braces half.
              var proposalKey = proposalKeyFor(p, i);
            var meta = ACTION_META[p.action_type] || { emoji: '✨', label: p.action_type };
            var cov = p.real_coverage || {};
            var added = !!addedProposalKeys[proposalKey];
            return (
              <div key={proposalKey} style={{ marginTop: 8, padding: 10, borderRadius: 11, border: '1px solid #fde68a', background: '#fffbeb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 15 }}>{meta.emoji}</span>
                  <span style={{ fontWeight: 700, fontSize: 12, color: '#92400e' }}>{meta.label}</span>
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 6, fontSize: 11 }}>
                  {cov.buildings_covered !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{cov.buildings_covered}</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>buildings covered</div>
                    </div>
                  )}
                  {cov.estimated_people !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{cov.estimated_people}</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>people reached</div>
                    </div>
                  )}
                  {cov.max_depth_m !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{fmtDepth(cov.max_depth_m)}m</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>max depth in zone</div>
                    </div>
                  )}
                  {cov.road_depth_m !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{fmtDepth(cov.road_depth_m)}m</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>water on road</div>
                    </div>
                  )}
                  {cov.service_reach_m !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{cov.service_reach_m}m</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>service reach</div>
                    </div>
                  )}
                </div>

                {p.validated_payload && p.validated_payload.snapped_facility_name && (
                  <div style={{ fontSize: 10, color: '#78716c', marginBottom: 6 }}>
                    📍 {p.validated_payload.snapped_facility_name}
                  </div>
                )}

                {p.ai_reasoning && (
                  <div style={{ fontSize: 10, color: '#a8a29e', fontStyle: 'italic', marginBottom: 8 }}>
                    💭 {p.ai_reasoning}
                  </div>
                )}

                <button
                  onClick={function () { onAddProposal(p, proposalKey); }}
                  disabled={added}
                  style={{
                    width: '100%', padding: '7px', borderRadius: 8, border: 'none',
                    background: added ? '#d6d3d1' : '#0d9488', color: 'white',
                    fontSize: 11, fontWeight: 700, cursor: added ? 'default' : 'pointer',
                  }}
                >
                  {added ? '✓ Added to plan' : 'Add to plan'}
                </button>
              </div>
            );
          })}

          {proposals.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button
                onClick={onApplyFullPlan}
                disabled={allAdded}
                style={{
                  flex: 2, padding: '8px', borderRadius: 9, border: 'none',
                  background: allAdded ? '#d6d3d1' : T.flow, color: allAdded ? '#57534e' : T.ink,
                  fontSize: 11.5, fontWeight: 800, cursor: allAdded ? 'default' : 'pointer',
                }}
              >
                {allAdded ? '✓ Plan applied' : 'Apply this plan'}
              </button>
              <button
                onClick={onRun}
                style={{ flex: 1, padding: '8px', borderRadius: 9, border: '1px solid #0d9488', background: 'transparent', color: '#0d9488', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}
              >
                ↻ Regenerate
              </button>
            </div>
          )}

          <button
            onClick={onDismiss}
            style={{ width: '100%', marginTop: 8, padding: '6px', borderRadius: 8, border: '1px solid ' + T.line, background: 'transparent', color: T.mint, opacity: 0.75, fontSize: 10.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
