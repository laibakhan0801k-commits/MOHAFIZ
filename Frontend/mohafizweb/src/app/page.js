import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";
import GetStartedButton from "@/components/GetStartedButton";

// Tailwind's scanner only picks up complete, static class-name strings —
// building "text-" + color at render time would silently compile to
// nothing. Writing the full class names out here keeps every combination
// visible to the scanner.
const SCENARIOS = [
  {
    name: "River Overflow",
    line: "Models the nullah breaching its banks, using real elevation data.",
    border: "border-[#2b547e]",
    bg: "bg-blue-50",
    dot: "bg-[#2b547e]",
    text: "text-[#2b547e]",
  },
  {
    name: "Rainfall",
    line: "Flash flooding when monsoon rain outpaces urban drainage.",
    border: "border-[#2b547e]",
    bg: "bg-blue-50",
    dot: "bg-[#2b547e]",
    text: "text-[#2b547e]",
  },
  {
    name: "Drainage Failure",
    line: "Blocked drains and encroached nullahs — the most common local cause.",
    border: "border-[#2b547e]",
    bg: "bg-blue-50",
    dot: "bg-[#2b547e]",
    text: "text-[#2b547e]",
  },
  {
    name: "Dam Release",
    line: "Rawal Dam's spillway releases into Korang Nullah, with real advance warning.",
    border: "border-[#2b547e]",
    bg: "bg-blue-50",
    dot: "bg-[#2b547e]",
    text: "text-[#2b547e]",
  },
];

const WHAT_IF_STEPS = [
  {
    n: "01",
    title: "See the shape of risk",
    body: "Translate a complex basin into a picture people can read together.",
  },
  {
    n: "02",
    title: "Find the decision point",
    body: "Understand which small action gives your family or district more room.",
  },
  {
    n: "03",
    title: "Move with confidence",
    body: "Share a clear next step with the people who need to act.",
  },
];

export default function Home() {
  return (
    <div className="bg-paper">
      <SiteNav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-ink text-paper px-6 py-24">
        <svg
          className="pointer-events-none absolute inset-0 w-full h-full opacity-40"
          viewBox="0 0 1200 500"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="contour-line stroke-flow"
            d="M-20,110 C220,60 460,160 700,110 C900,70 1060,150 1220,100"
            strokeWidth="1"
            fill="none"
          />
          <path
            className="contour-line stroke-flow"
            d="M-20,210 C240,160 470,250 720,200 C920,165 1070,240 1220,190"
            strokeWidth="1"
            fill="none"
            opacity="0.7"
          />
          <path
            className="contour-line stroke-line"
            d="M-20,310 C230,270 480,340 720,300 C920,270 1080,330 1220,290"
            strokeWidth="1"
            fill="none"
            opacity="0.5"
          />
        </svg>

        <div className="relative max-w-3xl mx-auto text-center">
          <h1 className="font-display text-5xl font-medium">Mohafiz</h1>
          <p className="font-display text-xl text-flow mt-2">Pakistan&rsquo;s what if engine</p>
          <p className="font-body text-lg mt-6 max-w-xl mx-auto opacity-80">
            Turn real flood data for Islamabad H-8/H-9 into a place-by-place
            response plan — before the water gets there.
          </p>
          <GetStartedButton className="mt-8" />
        </div>
      </section>

      {/* Start with "what if" */}
      <section className="bg-paper px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-8">
            <div>
              <div className="font-body text-xs font-semibold tracking-wide text-flow uppercase">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-flow mr-2 align-middle" />
                Try the thinking
              </div>
              <h2 className="font-display text-3xl text-ink mt-2">Start with &ldquo;what if&rdquo;?</h2>
            </div>
            <p className="font-body text-sm text-ink/60 max-w-xs sm:text-right">
              Every useful plan begins somewhere specific.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
            <div className="mh-card mh-fade-in bg-ink text-paper rounded-2xl px-6 py-6">
              <span className="inline-block font-body text-[10px] font-semibold tracking-wide uppercase bg-white/10 text-paper/70 rounded-full px-3 py-1">
                A question for Mohafiz
              </span>
              <h3 className="font-display text-xl mt-4">What if the nullah rises 1 metre?</h3>
              <div className="flex flex-wrap gap-2 mt-5">
                <span className="font-body text-xs bg-lime text-ink rounded-full px-3 py-1.5">
                  What if the nullah rises 1 metre?
                </span>
                <span className="font-body text-xs bg-white/10 text-paper/80 rounded-full px-3 py-1.5">
                  Which roads stay open near H-9?
                </span>
                <span className="font-body text-xs bg-white/10 text-paper/80 rounded-full px-3 py-1.5">
                  Where should our community shelter?
                </span>
              </div>
              <Link
                href="/how-it-works"
                className="inline-block mt-5 font-body text-sm text-lime hover:opacity-80 transition"
              >
                See a grounded answer →
              </Link>
            </div>

            <div className="space-y-6">
              {WHAT_IF_STEPS.map(function (step) {
                return (
                  <div key={step.n} className="mh-fade-in flex gap-4">
                    <span className="font-mono text-sm text-flow">{step.n}</span>
                    <div>
                      <h4 className="font-display text-base text-ink">{step.title}</h4>
                      <p className="font-body text-sm text-ink/60 mt-1">{step.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Why this matters */}
      <section className="bg-paper px-6 py-16">
        <div className="max-w-2xl mx-auto mh-card mh-fade-in bg-white/70 rounded-xl px-6 py-8">
          <p className="font-body text-base leading-relaxed text-ink/80">
            Islamabad and Rawalpindi flood for different reasons — a river
            overflowing its banks, monsoon rain that outpaces the drains,
            storm drains blocked by encroachment and garbage, even scheduled
            releases from Rawal Dam into Korang Nullah. Mohafiz models all
            four, using real elevation data, the actual road network, and
            Pakistan&rsquo;s own PMD flood thresholds — not a generic
            simulation.
          </p>
        </div>
      </section>

      {/* Scenarios — 4 cards */}
      <section className="bg-paper px-6 py-16">
        <div className="max-w-6xl mx-auto">
          <h2 className="font-display text-2xl text-ink mb-6">Scenarios Mohafiz models</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {SCENARIOS.map(function (s) {
              return (
                <div
                  key={s.name}
                  className={"mh-card mh-fade-in border-2 " + s.border + " rounded-xl " + s.bg + " px-5 py-4"}
                >
                  <div className="flex items-center gap-2">
                    <span className={"w-3 h-3 rounded-full " + s.dot} />
                    <h3 className={"font-display text-lg " + s.text}>{s.name}</h3>
                  </div>
                  <p className="font-body text-sm text-ink/70 mt-2">{s.line}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* The Real Story */}
      <section className="bg-paper px-6 py-16">
        <div className="max-w-3xl mx-auto mh-card mh-fade-in border-2 border-[#2b547e] bg-blue-50 rounded-xl px-6 py-8">
          <h2 className="font-display text-2xl mb-1 text-ink">The Real Story</h2>
          <p className="font-body text-xs text-ink/50 mb-6">
            Pakistan&rsquo;s 2025 monsoon season, by the numbers — NDMA / OCHA.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <div className="text-center">
              <div className="font-mono text-2xl font-medium text-alert">1,037+</div>
              <div className="font-body text-xs text-ink/60 mt-1">Lives lost</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-2xl font-medium text-alert">6.9M</div>
              <div className="font-body text-xs text-ink/60 mt-1">People affected</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-2xl font-medium text-alert">229,700+</div>
              <div className="font-body text-xs text-ink/60 mt-1">Homes damaged or destroyed</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-2xl font-medium text-alert">3M</div>
              <div className="font-body text-xs text-ink/60 mt-1">People displaced</div>
            </div>
          </div>

          <p className="font-body text-base leading-relaxed text-ink/80">
            Punjab and Khyber Pakhtunkhwa took the worst of it — Punjab&rsquo;s
            worst flooding in four decades, KP alone recording over 500
            deaths. The 2026 season is already underway, and by late July had
            killed over
            <span className="font-mono font-medium text-alert"> 100 </span>
            people, with the worst of the season still ahead. Most of the
            communities behind these numbers had no plan in place before the
            water arrived.
          </p>
          <Link href="/how-it-works" className="inline-block mt-6 font-body text-sm text-flow underline">
            Read the full walkthrough
          </Link>
        </div>
      </section>

      {/* Let's make room for better decisions */}
      <section className="bg-paper px-6 py-16">
        <div className="max-w-5xl mx-auto mh-card mh-fade-in bg-white/70 rounded-2xl px-8 py-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div>
            <div className="font-body text-xs font-semibold tracking-wide text-flow uppercase">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-flow mr-2 align-middle" />
              Readiness is shared
            </div>
            <h2 className="font-display text-2xl sm:text-3xl text-ink mt-2 max-w-md">
              Let&rsquo;s make room for better decisions.
            </h2>
            <p className="font-body text-sm text-ink/60 mt-2 max-w-sm">
              Explore Mohafiz and see how a local what-if can turn uncertainty
              into a next step.
            </p>
          </div>
          <GetStartedButton label="Explore the engine" variant="dark" />
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
