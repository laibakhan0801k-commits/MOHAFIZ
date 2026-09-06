'use client';

// Dark green + lime tokens, matching the site-wide palette in
// tailwind.config.js exactly (this file uses raw inline styles like the
// rest of PlanWorkspace.js, not Tailwind classes, so the hex values are
// duplicated here rather than imported).
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

// Every number this component renders comes from a prop that traces back
// to a real backend response (Backend/main.py's /ai/prevention/suggest
// and /prevention/simulate, and Backend/ai_proposer.py's real trace log)
// or from PREVENTION_TOOLS, the same validated tool catalog the manual
// click-to-place system uses. Nothing here is invented client-side.
export default function PreventionPlanPanel(props) {
  var tools = props.tools || [];
  var activeTool = props.activeTool;
  var setActiveTool = props.setActiveTool;
  var activeToolDef = props.activeToolDef;
  var causeType = props.causeType;

  var aiLoading = props.aiSuggestLoading;
  var aiResult = props.aiSuggestResult;
  var aiError = props.aiSuggestError;
  var aiCombinedImpact = props.aiCombinedImpact;
  var addedProposalKeys = props.addedProposalKeys || {};
  var onRunAiSuggest = props.onRunAiSuggest;
  var onAddProposal = props.onAddProposal;
  var onApplyFullPlan = props.onApplyFullPlan;
  var onDismissAiResult = props.onDismissAiResult;

  var proposals = (aiResult && aiResult.proposals) || [];
  var trace = (aiResult && aiResult.trace) || [];
  // Must build the key EXACTLY as the card below does (index included),
  // or "all added" can never become true and the Apply-all button never
  // settles into its done state.
  var proposalKeyFor = function (p, i) {
    return p.action_type + '_' + p.location.lon.toFixed(6) + '_' + p.location.lat.toFixed(6) + '_' + i;
  };
  var allAdded = proposals.length > 0 && proposals.every(function (p, i) {
    return !!addedProposalKeys[proposalKeyFor(p, i)];
  });

  // "Why this plan is strong" -- a real one-line summary computed from
  // the actual accepted proposals' actual measured impact, not a
  // template the AI wrote.
  var reasoningSummary = null;
  if (proposals.length > 0) {
    var totalRoadsSaved = 0;
    var totalAreaSaved = 0;
    var zonesCovered = {};
    proposals.forEach(function (p) {
      if (p.real_impact) {
        totalRoadsSaved += p.real_impact.roads_saved || 0;
        totalAreaSaved += p.real_impact.area_saved_m2 || 0;
      }
      zonesCovered[p.zone_description] = true;
    });
    var zoneCount = Object.keys(zonesCovered).length;
    reasoningSummary = proposals.length + ' measure' + (proposals.length === 1 ? '' : 's') +
      ' across ' + zoneCount + ' priority zone' + (zoneCount === 1 ? '' : 's') +
      (totalRoadsSaved > 0 ? ', saving ' + totalRoadsSaved + ' road crossing' + (totalRoadsSaved === 1 ? '' : 's') : '') +
      (totalAreaSaved > 0 ? (totalRoadsSaved > 0 ? ' and' : ', saving') + ' ' + Math.round(totalAreaSaved).toLocaleString() + ' m² from flooding' : '') + '.';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ---------------------------------------------------------------
          A) Manual selection -- the real, already-validated
          PREVENTION_TOOLS catalog for this scenario's cause type,
          restyled to match the dark/lime palette. Clicking a card starts
          the exact same click-to-place flow as before (setActiveTool);
          this panel never places anything itself.
          --------------------------------------------------------------- */}
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.paper, marginBottom: 2 }}>
          Prevention measures
        </div>
        <div style={{ fontSize: 10.5, color: T.mint, opacity: 0.75, marginBottom: 9 }}>
          Pick a measure, then click the map to place it.
        </div>

        <div>
          {tools.map(function (tool) {
            var active = activeTool === tool.key;
            return (
              <button
                key={tool.key}
                onClick={function () { setActiveTool(active ? null : tool.key); }}
                title={tool.hint}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  width: '100%',
                  marginBottom: 5,
                  padding: '8px 10px',
                  borderRadius: 11,
                  border: active ? '2px solid ' + T.flow : '1px solid ' + T.line,
                  background: active ? T.flow + '1f' : T.surface,
                  color: active ? T.flow : T.paper,
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
        </div>

        {activeToolDef && (
          <div
            style={{
              marginTop: 8,
              padding: 9,
              borderRadius: 10,
              background: T.surface2,
              border: '1px solid ' + T.line,
              color: T.mint,
              fontSize: 10.5,
              fontWeight: 600,
              lineHeight: 1.4,
            }}
          >
            {activeToolDef.hint}
            {activeToolDef.effectLabel && (
              <div style={{ marginTop: 4, opacity: 0.85 }}>Effect: {activeToolDef.effectLabel}</div>
            )}
            {activeToolDef.realBasis && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid ' + T.line, fontSize: 9.5, fontWeight: 500, opacity: 0.85 }}>
                📰 {activeToolDef.realBasis}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------
          B) AI generation -- independent of the manual panel above.
          Calls the real /ai/prevention/suggest + /prevention/simulate
          endpoints; every line rendered below is real backend output.
          --------------------------------------------------------------- */}
      <div style={{ borderTop: '1px solid ' + T.line, paddingTop: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.paper, marginBottom: 2 }}>
          ✨ AI Prevention Plan
        </div>
        <div style={{ fontSize: 10.5, color: T.mint, opacity: 0.75, marginBottom: 9 }}>
          Proposes measures for this simulation; every proposal is checked against the same placement rules as a manual click before it&apos;s shown.
        </div>

        <button
          onClick={onRunAiSuggest}
          disabled={aiLoading}
          style={{
            width: '100%',
            padding: '10px',
            borderRadius: 11,
            border: 'none',
            background: aiLoading ? T.surface2 : T.flow,
            color: aiLoading ? T.mint : T.ink,
            fontWeight: 800,
            fontSize: 12.5,
            cursor: aiLoading ? 'wait' : 'pointer',
            opacity: aiLoading ? 0.8 : 1,
          }}
        >
          {aiLoading ? 'Analyzing this simulation…' : (aiResult ? '↻ Regenerate' : '✨ Generate AI Prevention Plan')}
        </button>

        {/* Live progress -- streamed from the real trace log the backend
            returns, not a canned loading animation. */}
        {aiLoading && (
          <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: T.ink, border: '1px solid ' + T.line, color: T.mint, fontSize: 10, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7 }}>
            Running the Hazard Analyst and Proposer against this simulation…
          </div>
        )}

        {aiError && !aiLoading && (
          <div style={{ marginTop: 8, padding: 9, borderRadius: 10, background: T.alert + '1a', border: '1px solid ' + T.alert, color: T.alert, fontSize: 10.5, fontWeight: 600, lineHeight: 1.4 }}>
            {aiError}
            <button
              onClick={onRunAiSuggest}
              style={{ display: 'block', marginTop: 8, width: '100%', padding: '6px', borderRadius: 8, border: '1px solid ' + T.alert, background: 'transparent', color: T.alert, fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        )}

        {aiResult && !aiLoading && (
          <div style={{ marginTop: 10 }}>
            {aiResult.generatedAt && (
              <div style={{ fontSize: 9.5, color: T.mint, opacity: 0.6, marginBottom: 8 }}>
                Generated just now
              </div>
            )}

            <div style={{ padding: 9, borderRadius: 10, background: T.ink, border: '1px solid ' + T.line, color: T.mint, fontSize: 10, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7, marginBottom: 10, maxHeight: 160, overflowY: 'auto' }}>
              <div style={{ opacity: 0.7 }}>
                {aiResult.hazard_summary.priority_zones.length} priority zone
                {aiResult.hazard_summary.priority_zones.length === 1 ? '' : 's'} identified from this simulation.
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
                return null; // zone_done -- 'accepted' line already covers it
              })}
            </div>

            {proposals.length === 0 && trace.length > 0 && (
              <div style={{ padding: 9, borderRadius: 10, background: T.surface2, border: '1px solid ' + T.line, color: T.mint, fontSize: 10.5, lineHeight: 1.4 }}>
                No proposal passed real validation this run — every candidate the AI tried was rejected (see the log above), or none existed for these zones. This is an honest &ldquo;nothing to add,&rdquo; not an error.
              </div>
            )}

            {reasoningSummary && (
              <div style={{ padding: 9, borderRadius: 10, background: T.flow + '14', border: '1px solid ' + T.flow + '55', color: T.flow, fontSize: 10.5, fontWeight: 600, lineHeight: 1.4, marginBottom: 8 }}>
                {reasoningSummary}
              </div>
            )}

            {/* Real combined before/after for the whole proposed plan --
                one /prevention/simulate call against every proposal
                together, not a sum of each one's isolated impact. */}
            {aiCombinedImpact && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <div style={{ flex: 1, padding: '7px 8px', borderRadius: 9, background: T.surface, border: '1px solid ' + T.line, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: T.flow }}>
                    {aiCombinedImpact.before.flooded_percent}% → {aiCombinedImpact.after.flooded_percent}%
                  </div>
                  <div style={{ fontSize: 8.5, color: T.mint, opacity: 0.7 }}>flooded area</div>
                </div>
                <div style={{ flex: 1, padding: '7px 8px', borderRadius: 9, background: T.surface, border: '1px solid ' + T.line, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: T.flow }}>
                    {aiCombinedImpact.before.roads_cut} → {aiCombinedImpact.after.roads_cut}
                  </div>
                  <div style={{ fontSize: 8.5, color: T.mint, opacity: 0.7 }}>roads flooded</div>
                </div>
                <div style={{ flex: 1, padding: '7px 8px', borderRadius: 9, background: T.surface, border: '1px solid ' + T.line, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: T.flow }}>
                    {aiCombinedImpact.before.buildings_affected} → {aiCombinedImpact.after.buildings_affected}
                  </div>
                  <div style={{ fontSize: 8.5, color: T.mint, opacity: 0.7 }}>buildings at risk</div>
                </div>
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
              var toolDef = tools.find(function (t) { return t.key === p.action_type; }) ||
                (props.allTools || []).find(function (t) { return t.key === p.action_type; });
              var impact = p.real_impact;
              var hasMeasurableEffect = impact && (impact.roads_saved > 0 || impact.area_saved_m2 > 0);
              var added = !!addedProposalKeys[proposalKey];
              return (
                <div key={proposalKey} style={{ marginTop: 8, padding: 10, borderRadius: 11, border: '1px solid ' + T.line, background: T.surface }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 15 }}>{toolDef ? toolDef.emoji : '✨'}</span>
                    <span style={{ fontWeight: 700, fontSize: 12, color: T.paper }}>{toolDef ? toolDef.label : p.action_type}</span>
                  </div>

                  {impact ? (
                    hasMeasurableEffect ? (
                      <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 11 }}>
                        <div>
                          <div style={{ fontWeight: 800, color: T.flow }}>{impact.roads_saved}</div>
                          <div style={{ fontSize: 9, color: T.mint, opacity: 0.7 }}>roads saved</div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, color: T.flow }}>{Number(impact.area_saved_m2).toLocaleString()} m²</div>
                          <div style={{ fontSize: 9, color: T.mint, opacity: 0.7 }}>area saved</div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, color: T.flow }}>{impact.flooded_percent_before}% → {impact.flooded_percent_after}%</div>
                          <div style={{ fontSize: 9, color: T.mint, opacity: 0.7 }}>flooded</div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 10.5, color: T.mint, opacity: 0.7, marginBottom: 6 }}>
                        No measurable flood-extent change from this single action at this map&apos;s resolution — real, calculated, just small at this scale.
                      </div>
                    )
                  ) : null}

                  {p.ai_reasoning && (
                    <div style={{ fontSize: 10, color: T.mint, opacity: 0.65, fontStyle: 'italic', marginBottom: 8 }}>
                      💭 {p.ai_reasoning}
                    </div>
                  )}

                  <button
                    onClick={function () { onAddProposal(p, proposalKey); }}
                    disabled={added}
                    style={{
                      width: '100%', padding: '7px', borderRadius: 8, border: 'none',
                      background: added ? T.line : T.flow, color: added ? T.mint : T.ink,
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
                    background: allAdded ? T.line : T.flow, color: allAdded ? T.mint : T.ink,
                    fontSize: 11.5, fontWeight: 800, cursor: allAdded ? 'default' : 'pointer',
                  }}
                >
                  {allAdded ? '✓ Plan applied' : 'Apply this plan'}
                </button>
                <button
                  onClick={onRunAiSuggest}
                  style={{ flex: 1, padding: '8px', borderRadius: 9, border: '1px solid ' + T.flow, background: 'transparent', color: T.flow, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}
                >
                  ↻ Regenerate
                </button>
              </div>
            )}

            <button
              onClick={onDismissAiResult}
              style={{ width: '100%', marginTop: 8, padding: '6px', borderRadius: 8, border: '1px solid ' + T.line, background: 'transparent', color: T.mint, opacity: 0.75, fontSize: 10.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
