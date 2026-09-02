import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

const NODES = [
  { x: 100, label: "Scenario" },
  { x: 300, label: "Plan" },
  { x: 500, label: "Implement" },
  { x: 700, label: "Report" },
  { x: 900, label: "Refine" },
];

function LoopDiagram() {
  return (
    <svg viewBox="0 0 1000 250" className="mx-auto w-full max-w-3xl" role="img" aria-label="Five-step loop: Scenario, Plan, Implement, Report, Refine — Refine feeds back into Plan.">
      <line x1="126" y1="60" x2="874" y2="60" className="stroke-line" strokeWidth="1" opacity="0.4" />

      <path
        d="M900,86 C860,214 340,214 300,86"
        className="stroke-flow"
        strokeWidth="1.5"
        fill="none"
        opacity="0.7"
      />
      <polygon points="300,86 293,72 309,76" className="fill-flow" opacity="0.7" />

      {NODES.map(function (node, i) {
        const isPlanStep = node.label === "Plan";
        return (
          <g key={node.label}>
            {/* "Eraser" rects blank out the connecting line behind each
                label — must match the section's own dark background,
                not the (now light) paper token. */}
            <rect x={node.x - 42} y="92" width="84" height="20" className="fill-ink" />
            <circle cx={node.x} cy="60" r="26" className={isPlanStep ? "fill-line" : "fill-flow"} />
            <text
              x={node.x}
              y="67"
              textAnchor="middle"
              className={isPlanStep ? "fill-paper font-mono" : "fill-ink font-mono"}
              style={{ fontSize: 20 }}
            >
              {i + 1}
            </text>
            <text
              x={node.x}
              y="107"
              textAnchor="middle"
              className="fill-paper font-display"
              style={{ fontSize: 15, fontWeight: 500 }}
            >
              {node.label}
            </text>

            {isPlanStep && (
              <g>
                <rect x={node.x - 90} y="126" width="180" height="20" className="fill-ink" />
                <rect x={node.x - 86} y="130" width="8" height="8" className="fill-flow" />
                <text x={node.x - 74} y="138" className="fill-mint font-body" style={{ fontSize: 11 }}>
                  Prevention
                </text>
                <rect x={node.x + 8} y="130" width="8" height="8" className="fill-alert" />
                <text x={node.x + 20} y="138" className="fill-mint font-body" style={{ fontSize: 11 }}>
                  Response
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function HowIcon({ name, className }) {
  const common = {
    className: className || "w-6 h-6 stroke-flow",
    fill: "none",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  };

  if (name === "river") {
    return (
      <svg {...common}>
        <path d="M2 8c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0" />
        <path d="M2 14c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0" />
        <path d="M2 20c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0" opacity="0.5" />
      </svg>
    );
  }
  if (name === "rain") {
    return (
      <svg {...common}>
        <path d="M6.5 10.5a4 4 0 0 1 .5-7.9 5.5 5.5 0 0 1 10.6 1.6A4.2 4.2 0 0 1 17 12H7.2" />
        <path d="M8 15v3M12 15v4M16 15v3" />
      </svg>
    );
  }
  if (name === "drain") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M7 9h10M7 12h10M7 15h10" opacity="0.7" />
      </svg>
    );
  }
  if (name === "dam") {
    return (
      <svg {...common}>
        <path d="M4 5h13v9h-4v6H4V5Z" />
        <path d="M17 11h3v9h-9v-3" />
        <path d="M2 20c1.5-1.6 3-1.6 4.5 0s3 1.6 4.5 0" opacity="0.7" />
      </svg>
    );
  }
  if (name === "shovel") {
    return (
      <svg {...common}>
        <path d="M17 3 21 7l-8.5 8.5" />
        <path d="M11 13.5c-1 3-2.5 4.8-4.5 5.8-1.3.6-2.8.7-3.5 0-.7-.7-.6-2.2 0-3.5 1-2 2.8-3.5 5.8-4.5" />
      </svg>
    );
  }
  if (name === "sandbag") {
    return (
      <svg {...common}>
        <path d="M4 18c0-2.8 3.6-4 8-4s8 1.2 8 4-3.6 3-8 3-8-.2-8-3Z" />
        <path d="M6 14c0-2.5 3-3.6 6-3.6s6 1.1 6 3.6" opacity="0.7" />
      </svg>
    );
  }
  if (name === "printer") {
    return (
      <svg {...common}>
        <path d="M6 8V3h12v5" />
        <rect x="3" y="8" width="18" height="8" rx="1.5" />
        <path d="M6 16h12v5H6v-5Z" />
      </svg>
    );
  }
  if (name === "document") {
    return (
      <svg {...common}>
        <path d="M6 2.5h9l3 3V21.5H6V2.5Z" />
        <path d="M15 2.5v3h3" />
        <path d="M8.5 12h7M8.5 15.5h7M8.5 18.5h4" opacity="0.7" />
      </svg>
    );
  }
  if (name === "refresh") {
    return (
      <svg {...common}>
        <path d="M4 12a8 8 0 0 1 13.6-5.7L20 8.5" />
        <path d="M20 3.5v5h-5" />
        <path d="M20 12a8 8 0 0 1-13.6 5.7L4 15.5" />
        <path d="M4 20.5v-5h5" />
      </svg>
    );
  }
  if (name === "search") {
    return (
      <svg {...common}>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m20 20-4.8-4.8" />
      </svg>
    );
  }
  if (name === "spark") {
    return (
      <svg {...common} fill="currentColor" stroke="none">
        <path d="M12 2c.6 3.8 1.9 5.1 5.7 5.7-3.8.6-5.1 1.9-5.7 5.7-.6-3.8-1.9-5.1-5.7-5.7C10.1 7.1 11.4 5.8 12 2Z" />
        <path d="M19 14c.3 1.8.9 2.4 2.7 2.7-1.8.3-2.4.9-2.7 2.7-.3-1.8-.9-2.4-2.7-2.7 1.8-.3 2.4-.9 2.7-2.7Z" />
      </svg>
    );
  }
  return null;
}

function Badge({ children, color }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-body text-[10px] font-semibold uppercase tracking-wide " +
        (color === "alert" ? "border-alert text-alert" : "border-flow text-flow")
      }
    >
      {children}
    </span>
  );
}

export default function HowItWorksPage() {
  return (
    <div className="bg-ink">
      <SiteNav />

      <section className="bg-ink px-6 pt-16 pb-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="font-display text-4xl font-medium text-paper">How it Works</h1>
          <p className="font-body text-sm text-mint mt-3">
            Mohafiz follows one loop: simulate, plan, implement, report,
            refine.
          </p>
        </div>
      </section>

      <section className="bg-ink px-6 pb-16">
        <LoopDiagram />
      </section>

      <section className="bg-ink px-6 pb-16">
        <div className="max-w-6xl mx-auto">
          {/* Row 1 — Scenario, Plan, and the AI assistance add-on */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-5">
            <div className="lg:col-span-5 mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-7 py-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-lg text-flow">1</span>
                  <h2 className="font-display text-lg text-paper">Pick a scenario &amp; severity</h2>
                </div>
                <Badge>AI Suggest</Badge>
              </div>

              <div className="flex items-center gap-4 mt-5">
                <HowIcon name="river" className="w-7 h-7 stroke-flow" />
                <HowIcon name="rain" className="w-7 h-7 stroke-flow" />
                <HowIcon name="drain" className="w-7 h-7 stroke-flow" />
                <HowIcon name="dam" className="w-7 h-7 stroke-flow" />
              </div>

              <p className="font-body text-sm leading-relaxed text-mint mt-4">
                Choose from four real flood causes — River Overflow, Rainfall,
                Drainage Failure, or Dam Release — then set a severity level.
                For Rainfall, severity follows Pakistan&rsquo;s own PMD
                intensity bands, from light to extremely heavy. Each scenario
                runs against real elevation and road data for H-8/H-9.
              </p>
            </div>

            <div className="lg:col-span-4 mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-7 py-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-lg text-flow">2</span>
                <h2 className="font-display text-lg text-paper">Build your plan</h2>
              </div>

              <div className="flex items-center gap-4 mt-5">
                <HowIcon name="shovel" className="w-7 h-7 stroke-flow" />
                <HowIcon name="sandbag" className="w-7 h-7 stroke-flow" />
              </div>

              <p className="font-body text-sm leading-relaxed text-mint mt-4">
                Every scenario supports two kinds of plan, each with its own
                placement rules, checked against the live simulation.
              </p>

              <div className="font-body text-[10px] font-semibold uppercase tracking-wide text-mint/70 mt-5 mb-2">
                Plan types
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1 rounded-lg bg-flow/10 border-l-4 border-flow px-4 py-3">
                  <div className="font-body text-xs font-semibold text-flow">Prevention</div>
                  <p className="font-body text-xs leading-relaxed text-mint mt-1">
                    Before the flood — drains, embankments, floodproofing.
                  </p>
                </div>
                <div className="flex-1 rounded-lg bg-alert/10 border-l-4 border-alert px-4 py-3">
                  <div className="font-body text-xs font-semibold text-alert">Response</div>
                  <p className="font-body text-xs leading-relaxed text-mint mt-1">
                    During the flood — evacuation, closures, medical posts.
                  </p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 mh-card mh-fade-in bg-surface-2 border border-flow/40 rounded-2xl px-6 py-6">
              <div className="flex items-center gap-2">
                <HowIcon name="spark" className="w-5 h-5 text-flow" />
                <div className="font-body text-[10px] font-semibold uppercase tracking-wide text-flow">
                  Add-on: AI assistance
                </div>
              </div>
              <p className="font-body text-xs leading-relaxed text-mint mt-3">
                Get proactive AI suggestions for optimized placement,
                separately applied to both Prevention and Response plans.
              </p>

              <div className="mt-4 space-y-3">
                <div>
                  <div className="font-body text-xs font-semibold text-flow">AI Prevention</div>
                  <p className="font-body text-xs leading-relaxed text-mint mt-0.5">
                    Refines embankment placement for maximum cost benefit.
                  </p>
                </div>
                <div>
                  <div className="font-body text-xs font-semibold text-alert">AI Response</div>
                  <p className="font-body text-xs leading-relaxed text-mint mt-0.5">
                    Predicts critical evacuation points and optimized rescue paths.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Row 2 — Implement, Report, Refine */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div className="mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-7 py-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-lg text-flow">3</span>
                <h2 className="font-display text-lg text-paper">Implement &amp; compare</h2>
              </div>

              <div className="flex items-center gap-2 mt-5">
                <div className="relative flex-1 h-20 rounded-md overflow-hidden border border-line">
                  <img
                    src="https://images.unsplash.com/photo-1732285861430-be924933fc45?w=500&q=80&auto=format&fit=crop"
                    alt=""
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute bottom-1 left-1.5 font-body text-[9px] font-semibold uppercase tracking-wide text-paper bg-ink/70 px-1.5 py-0.5 rounded">
                    Before
                  </span>
                </div>
                <span className="font-mono text-flow text-sm shrink-0">»</span>
                <div className="relative flex-1 h-20 rounded-md overflow-hidden border border-alert">
                  <img
                    src="https://images.unsplash.com/photo-1762624822556-921847c110d9?w=500&q=80&auto=format&fit=crop"
                    alt=""
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute bottom-1 left-1.5 font-body text-[9px] font-semibold uppercase tracking-wide text-paper bg-alert/80 px-1.5 py-0.5 rounded">
                    After
                  </span>
                </div>
              </div>

              <p className="font-body text-sm leading-relaxed text-mint mt-4">
                Once your plan is placed, implement it to see a
                before-and-after view of how your actions change the flooded
                area and what&rsquo;s still at risk.
              </p>
            </div>

            <div className="mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-7 py-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-lg text-flow">4</span>
                  <h2 className="font-display text-lg text-paper">Generate a report</h2>
                </div>
                <Badge>See impact</Badge>
              </div>

              <div className="flex items-center gap-4 mt-5">
                <HowIcon name="printer" className="w-7 h-7 stroke-flow" />
                <HowIcon name="document" className="w-7 h-7 stroke-flow" />
              </div>

              <p className="font-body text-sm leading-relaxed text-mint mt-4">
                Every plan can be exported as a clean report: each action, its
                location, and its details, ready to hand to a field team —
                not a screenshot, an actual operational brief.
              </p>
            </div>

            <div className="mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-7 py-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-lg text-flow">5</span>
                <h2 className="font-display text-lg text-paper">Refine</h2>
              </div>

              <div className="flex items-center gap-4 mt-5">
                <HowIcon name="refresh" className="w-7 h-7 stroke-flow" />
                <HowIcon name="search" className="w-7 h-7 stroke-flow" />
              </div>

              <div className="font-body text-[10px] font-semibold uppercase tracking-wide text-flow mt-4">
                AI-powered refinement
              </div>
              <p className="font-body text-sm leading-relaxed text-mint mt-2">
                Identify data-driven performance gaps. Mohafiz feeds the
                analysis directly back into Step 2, for a new AI-guided plan
                iteration.
              </p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
