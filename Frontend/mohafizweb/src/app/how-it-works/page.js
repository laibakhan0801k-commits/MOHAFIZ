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

const STEPS = [
  {
    n: "1",
    title: "Pick a scenario & severity",
    border: "border-flow",
    numColor: "text-flow",
    body: "Choose from four real flood causes — River Overflow, Rainfall, Drainage Failure, or Dam Release — then set a severity level. For Rainfall, severity follows Pakistan's own PMD intensity bands, from light to extremely heavy. Each scenario runs against real elevation and road data for H-8/H-9.",
  },
  {
    n: "2",
    title: "Build your plan",
    border: "border-flow",
    numColor: "text-flow",
    body: "Every scenario supports two kinds of plan. A Prevention plan reduces risk before a flood happens — clearing drains, reinforcing embankments, marking buildings for floodproofing. A Response plan is what to do once flooding is already underway — evacuation zones, road closures, medical posts, rescue staging points. Each action has its own placement rules, checked against the live simulation.",
    split: true,
  },
  {
    n: "3",
    title: "Implement & compare",
    border: "border-flow",
    numColor: "text-flow",
    body: "Once your plan is placed, implement it to see its effect on the map — a before-and-after view showing how your actions change the flooded area and what's still at risk.",
  },
  {
    n: "4",
    title: "Generate a report",
    border: "border-flow",
    numColor: "text-flow",
    body: "Every plan can be exported as a clean report: each action, its location, and its details, ready to hand to a field team — not a screenshot, an actual operational brief.",
  },
  {
    n: "5",
    title: "AI suggestions",
    border: "border-alert",
    numColor: "text-alert",
    body: "After you've built a plan, Mohafiz reviews it against the simulation and flags gaps — an evacuation zone that doesn't reach a drainage-risk pocket, a medical post too far from where people are being evacuated. Suggestions, not automation — you stay in control of the plan.",
  },
];

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
        <div className="max-w-2xl mx-auto space-y-6">
          {STEPS.map(function (step) {
            return (
              <div
                key={step.n}
                className={"mh-card mh-fade-in border-l-4 " + step.border + " bg-surface rounded-xl px-6 py-5"}
              >
                <div className="flex items-baseline gap-3">
                  <span className={"font-mono text-lg " + step.numColor}>{step.n}</span>
                  <h2 className="font-display text-lg text-paper">{step.title}</h2>
                </div>
                <p className="font-body text-sm leading-relaxed text-mint mt-3">{step.body}</p>

                {step.split && (
                  <div className="mt-5 flex flex-col sm:flex-row gap-3">
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
                )}
              </div>
            );
          })}
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
