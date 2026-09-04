"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8002";

const CAUSE_LABELS = {
  rainfall: "🌧️ Rainfall",
  river_overflow: "🌊 River Overflow",
  drainage_failure: "🕳️ Drainage Failure",
  dam_release: "🚰 Dam Release",
};

function causeLabel(causeType) {
  return CAUSE_LABELS[causeType] || causeType || "Unknown scenario";
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch (err) {
    return iso;
  }
}

// Real counts pulled straight from the plan's own saved actions snapshot
// (PlanWorkspace.js's savePlanIfLoggedIn) -- not re-derived or guessed.
function actionCount(plan) {
  const a = plan.actions || {};
  const markers = Array.isArray(a.markers) ? a.markers.length : 0;
  const closedRoads = Array.isArray(a.closedRoads) ? a.closedRoads.length : 0;
  const embankments = Array.isArray(a.embankments) ? a.embankments.length : 0;
  return markers + closedRoads + embankments;
}

function humanizeKey(key) {
  return String(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, function (c) { return c.toUpperCase(); })
    .trim();
}

// Human-readable facts about one marker -- what PlanWorkspace measured
// at placement time (m.info) plus the tool's own params (m.params) --
// instead of dumping those objects raw.
function markerDetailLines(m) {
  const lines = [];
  if (m.info && typeof m.info === "object") {
    Object.keys(m.info).forEach(function (k) { lines.push(k + ": " + m.info[k]); });
  }
  if (m.params && typeof m.params === "object") {
    Object.keys(m.params).forEach(function (k) {
      const v = m.params[k];
      if (v === undefined || v === null || v === "") return;
      lines.push(humanizeKey(k) + ": " + v);
    });
  }
  if (m.targetSegmentName) lines.push("Waterway: " + m.targetSegmentName);
  return lines;
}

// Flattens the plan's raw markers/closedRoads/embankments (the same
// shape PlanWorkspace.js's state holds -- _uid, params, etc. included)
// into a readable {emoji, label, lat, lon, details[]} per placed item.
function planActionItems(plan) {
  const a = plan.actions || {};
  const items = [];
  (a.markers || []).forEach(function (m, i) {
    items.push({
      key: "m-" + (m._uid || i),
      type: m.type || "action",
      emoji: m.emoji || "📍",
      label: m.label || "Action",
      lat: m.lat, lon: m.lon,
      details: markerDetailLines(m),
    });
  });
  (a.closedRoads || []).forEach(function (r, i) {
    items.push({
      key: "r-" + (r._uid || i),
      type: r.actionType || "closeRoad",
      emoji: "🚧",
      label: "Road closure & diversion point",
      lat: r.lat, lon: r.lon,
      details: [
        r.roadName ? "Road: " + r.roadName : null,
        r.durationHr ? "Expected duration: " + r.durationHr + "hr" : null,
      ].filter(Boolean),
    });
  });
  (a.embankments || []).forEach(function (e, i) {
    items.push({
      key: "e-" + (e._uid || i),
      type: "embankment",
      emoji: "🧱",
      label: "Embankment",
      lat: e.anchorLat, lon: e.anchorLng,
      details: [
        e.heightM != null ? "Height: " + e.heightM + "m" : null,
        e.lengthM != null ? "Length: " + e.lengthM + "m" : null,
        e.material ? "Material: " + e.material : null,
      ].filter(Boolean),
    });
  });
  return items;
}

// Same grouping logic as PlanWorkspace.js's buildReportCounts -- group
// by type, keep the first occurrence's label/emoji, count occurrences --
// reused here rather than re-invented so both places agree.
function planActionCounts(items) {
  const counts = {};
  items.forEach(function (it) {
    if (!counts[it.type]) counts[it.type] = { label: it.label, emoji: it.emoji, count: 0 };
    counts[it.type].count++;
  });
  return Object.keys(counts)
    .map(function (k) { return counts[k]; })
    .sort(function (a, b) { return b.count - a.count; });
}

function isResponseImpactSummary(s) {
  return !!(s && s.after && Array.isArray(s.after.statRows));
}

function isPreventionSummary(s) {
  return !!(s && s.before && s.after && s.before.flooded_percent !== undefined);
}

const VERDICT_TONE_CLASS = {
  good: "text-flow",
  bad: "text-alert",
  warn: "text-mint",
  neutral: "text-mint/70",
};

export default function MyPlansPage() {
  const [status, setStatus] = useState("checking"); // checking | logged_out | loading | ready | error
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("mohafiz_token");
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser-only localStorage after mount, deliberately deferred to avoid SSR/CSR hydration mismatch
      setStatus("logged_out");
      return;
    }

    setStatus("loading");
    fetch(API_URL + "/plans/mine", {
      headers: { Authorization: "Bearer " + token },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        setPlans(Array.isArray(data) ? data : []);
        setStatus("ready");
      })
      .catch(function (err) {
        console.error("Failed to load saved plans:", err);
        setError(err.message || String(err));
        setStatus("error");
      });
  }, []);

  return (
    <div className="bg-ink flex flex-col min-h-screen">
      <SiteNav />
      <section className="bg-ink px-6 py-16 flex-1">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="font-display text-3xl text-paper">My Plans</h1>
              <p className="font-body text-sm text-mint mt-2">
                Response and prevention plans you&rsquo;ve saved from a generated report.
              </p>
            </div>
            <Link href="/" className="font-body text-sm text-flow underline underline-offset-4 hover:opacity-80 transition">
              ← Back to home
            </Link>
          </div>

          {status === "checking" && null}

          {status === "logged_out" && (
            <div className="mh-card bg-surface border-l-4 border-alert rounded-xl px-8 py-10 text-center">
              <p className="font-body text-sm text-mint">
                Log in to see plans you&rsquo;ve saved to your account.
              </p>
              <Link href="/login" className="font-body text-sm text-flow underline underline-offset-4 mt-4 inline-block">
                Go to login →
              </Link>
            </div>
          )}

          {status === "loading" && (
            <div className="mh-card bg-surface rounded-xl px-8 py-10 text-center">
              <p className="font-body text-sm text-mint">Loading your saved plans…</p>
            </div>
          )}

          {status === "error" && (
            <div className="mh-card bg-surface border-l-4 border-alert rounded-xl px-8 py-10 text-center">
              <p className="font-body text-sm text-mint">
                Could not load your saved plans — check the backend is running.
              </p>
              {error && <p className="font-mono text-xs text-mint/60 mt-2">{error}</p>}
            </div>
          )}

          {status === "ready" && plans.length === 0 && (
            <div className="mh-card bg-surface rounded-xl px-8 py-10 text-center">
              <p className="font-body text-sm text-mint">
                Nothing saved yet. Build a plan on the map, then generate a report
                (Print/Save PDF, Download .txt, or an Impact Report) to save it here.
              </p>
              <Link href="/map" className="font-body text-sm text-flow underline underline-offset-4 mt-4 inline-block">
                Start a simulation →
              </Link>
            </div>
          )}

          {status === "ready" && plans.length > 0 && (
            <div className="space-y-3">
              {plans.map(function (plan) {
                const expanded = expandedId === plan.id;
                const snap = plan.scenario_snapshot || {};
                const items = expanded ? planActionItems(plan) : [];
                const counts = expanded ? planActionCounts(items) : [];
                const summary = plan.report_summary;
                return (
                  <div key={plan.id} className="mh-card bg-surface rounded-xl overflow-hidden border border-line">
                    <button
                      onClick={function () { setExpandedId(expanded ? null : plan.id); }}
                      className="w-full flex items-center justify-between gap-4 px-6 py-4 text-left hover:bg-surface-2 transition"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={
                            "font-body text-[11px] font-semibold uppercase tracking-wide rounded-full px-3 py-1 " +
                            (plan.plan_type === "response" ? "bg-alert/15 text-alert" : "bg-flow/15 text-flow")
                          }
                        >
                          {plan.plan_type === "response" ? "🚨 Response" : "🛡️ Prevention"}
                        </span>
                        <span className="font-body text-sm text-paper">{causeLabel(snap.cause_type)}</span>
                        {snap.water_level_m !== undefined && snap.water_level_m !== null && (
                          <span className="font-mono text-xs text-mint/70">{snap.water_level_m}m</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-body text-xs text-mint/70">
                          {actionCount(plan)} action{actionCount(plan) === 1 ? "" : "s"}
                        </span>
                        <span className="font-mono text-xs text-mint/60">{formatDate(plan.created_at)}</span>
                        <span className="text-mint/60">{expanded ? "▲" : "▼"}</span>
                      </div>
                    </button>

                    {expanded && (
                      <div className="px-6 pb-6 pt-1 border-t border-line">
                        {/* Actions placed, grouped by type -- the same
                            emoji/label/count grouping PlanWorkspace.js's
                            own report summary uses, shown as chips
                            instead of a raw counts object. */}
                        {counts.length > 0 ? (
                          <div className="flex flex-wrap gap-2 mt-4">
                            {counts.map(function (c, i) {
                              return (
                                <span
                                  key={i}
                                  className="inline-flex items-center gap-1.5 font-body text-xs text-paper bg-ink/50 border border-line rounded-lg px-2.5 py-1.5"
                                >
                                  <span>{c.emoji}</span>
                                  {c.label}
                                  <span className="text-mint/70">×{c.count}</span>
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="font-body text-xs text-mint/60 mt-4">
                            No actions were placed on this plan.
                          </p>
                        )}

                        {/* Response Impact Report summary, if this save
                            captured one -- real coverage stat rows, not
                            the raw report object. */}
                        {isResponseImpactSummary(summary) && (
                          <div className="mt-4">
                            <p className="font-body text-xs text-mint/80 mb-2">{summary.summaryLine}</p>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {summary.after.statRows.map(function (r, i) {
                                return (
                                  <div key={i} className="bg-ink/40 border border-line rounded-lg px-3 py-2">
                                    <div className="font-mono text-sm font-bold text-flow">{r.value}</div>
                                    <div className="font-body text-[11px] text-mint/70">{r.suffix}</div>
                                  </div>
                                );
                              })}
                            </div>
                            {summary.verdict && (
                              <p className={"font-body text-xs mt-2 " + (VERDICT_TONE_CLASS[summary.verdict.tone] || "text-mint/70")}>
                                {summary.verdict.text}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Prevention simulation summary, if this save
                            came from Run Simulation -- the same
                            before/after/difference fields PlanWorkspace's
                            own sidebar shows. */}
                        {isPreventionSummary(summary) && (
                          <div className="mt-4">
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div className="font-body text-[11px] uppercase tracking-wide text-mint/60 mb-1">Before</div>
                                <div className="font-body text-xs text-paper space-y-0.5">
                                  <div>{summary.before.flooded_percent}% area flooded</div>
                                  <div>{summary.before.roads_cut} roads cut</div>
                                  <div>{summary.before.buildings_affected} buildings affected</div>
                                  <div>{summary.before.avg_depth_m}m avg depth</div>
                                </div>
                              </div>
                              <div>
                                <div className="font-body text-[11px] uppercase tracking-wide text-flow/80 mb-1">After</div>
                                <div className="font-body text-xs text-paper space-y-0.5">
                                  <div>{summary.after.flooded_percent}% area flooded</div>
                                  <div>{summary.after.roads_cut} roads cut</div>
                                  <div>{summary.after.buildings_affected} buildings affected</div>
                                  <div>{summary.after.avg_depth_m}m avg depth</div>
                                </div>
                              </div>
                            </div>
                            {summary.difference && (summary.difference.water_level_saved_m > 0 || summary.difference.volume_stored_m3 > 0) && (
                              <p className="font-body text-xs text-flow mt-3 font-semibold">
                                {summary.difference.water_level_saved_m > 0 &&
                                  "Water level lowered by " + summary.difference.water_level_saved_m + "m. "}
                                {summary.difference.volume_stored_m3 > 0 &&
                                  Number(summary.difference.volume_stored_m3).toLocaleString() + " m³ intercepted before it reaches the floodplain."}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Per-item facts -- label, coordinates, and
                            whatever was actually measured at placement
                            (m.info/m.params), not the stored JSON shape. */}
                        {items.length > 0 && (
                          <details className="mt-4">
                            <summary className="font-body text-xs text-flow cursor-pointer">
                              View plan details ({items.length} item{items.length === 1 ? "" : "s"})
                            </summary>
                            <div className="mt-2 space-y-2">
                              {items.map(function (it) {
                                return (
                                  <div key={it.key} className="bg-ink/40 border border-line rounded-lg px-3 py-2">
                                    <div className="font-body text-xs text-paper font-semibold">
                                      {it.emoji} {it.label}
                                    </div>
                                    {it.lat !== undefined && it.lon !== undefined && (
                                      <div className="font-mono text-[10px] text-mint/60 mt-0.5">
                                        {Number(it.lat).toFixed(5)}, {Number(it.lon).toFixed(5)}
                                      </div>
                                    )}
                                    {it.details.length > 0 && (
                                      <div className="font-body text-[11px] text-mint/80 mt-1 space-y-0.5">
                                        {it.details.map(function (d, i) { return <div key={i}>{d}</div>; })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
