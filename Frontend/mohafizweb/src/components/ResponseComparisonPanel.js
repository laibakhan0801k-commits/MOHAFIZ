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

const ACTION_META = {
  warningPoint: { emoji: '📢', label: 'Warning announcement point' },
  evacuationZone: { emoji: '⚠️', label: 'Priority evacuation zone' },
  closeRoad: { emoji: '🚧', label: 'Road closure & diversion point' },
  boatLaunch: { emoji: '🛟', label: 'Boat launch point' },
  reliefMedicalPost: { emoji: '🏕️', label: 'Relief camp / medical post' },
};

// Every number this component renders comes from a real backend response
// (Backend/main.py's /ai/response/compare -- the Hazard Reader,
// Strategist, and Impact Evaluator agents) or the real validated_payload
// on each proposal. Nothing here is invented client-side.
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

  var reasoningSummary = null;
  if (proposals.length > 0) {
    var withReasoning = proposals.filter(function (p) { return p.ai_reasoning; });
    if (withReasoning.length > 0) reasoningSummary = withReasoning[0].ai_reasoning;
  }
  var allAdded = proposals.length > 0 && proposals.every(function (p) {
    var key = p.action_type + '_' + p.location.lon.toFixed(6) + '_' + p.location.lat.toFixed(6);
    return !!addedProposalKeys[key];
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
              {[
                { label: 'Evacuation coverage', before: comparison.before.evacuation.percent, after: comparison.after.evacuation.percent, unit: '%' },
                { label: 'Roads closed', before: comparison.before.roads.closed, after: comparison.after.roads.closed, unit: '' },
                { label: 'Rescue-staging coverage', before: comparison.before.rescue.percent, after: comparison.after.rescue.percent, unit: '%' },
                { label: 'Relief/medical coverage', before: comparison.before.relief.percent, after: comparison.after.relief.percent, unit: '%' },
                { label: 'Warning coverage', before: comparison.before.warning.percent, after: comparison.after.warning.percent, unit: '%' },
              ].map(function (row, i) {
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

          {proposals.map(function (p, i) {
            var proposalKey = p.action_type + '_' + p.location.lon.toFixed(6) + '_' + p.location.lat.toFixed(6);
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
                      <div style={{ fontWeight: 800, color: '#059669' }}>{cov.max_depth_m}m</div>
                      <div style={{ fontSize: 9, color: '#78716c' }}>max depth in zone</div>
                    </div>
                  )}
                  {cov.road_depth_m !== undefined && (
                    <div>
                      <div style={{ fontWeight: 800, color: '#059669' }}>{cov.road_depth_m}m</div>
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
