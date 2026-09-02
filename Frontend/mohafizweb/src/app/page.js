import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";
import GetStartedButton from "@/components/GetStartedButton";
import HeroFloodPreview from "@/components/HeroFloodPreview";
import CountUpNumber from "@/components/CountUpNumber";

// Tailwind's scanner only picks up complete, static class-name strings —
// building "text-" + color at render time would silently compile to
// nothing. Writing the full class names out here keeps every combination
// visible to the scanner.
const SCENARIOS = [
  {
    name: "River Overflow",
    line: "Models the nullah breaching its banks, using real elevation data.",
    image: "https://images.unsplash.com/photo-1783103957862-06b844e495f2?w=600&q=80&auto=format&fit=crop",
  },
  {
    name: "Rainfall",
    line: "Flash flooding when monsoon rain outpaces urban drainage.",
    image: "https://images.unsplash.com/photo-1759299983355-6ddc9a9d8ba5?w=600&q=80&auto=format&fit=crop",
  },
  {
    name: "Drainage Failure",
    line: "Blocked drains and encroached nullahs — the most common local cause.",
    image: "https://images.unsplash.com/photo-1745265797120-7c9718c72659?w=600&q=80&auto=format&fit=crop",
  },
  {
    name: "Dam Release",
    line: "Rawal Dam's spillway releases into Korang Nullah, with real advance warning.",
    image: "https://images.unsplash.com/photo-1639237046487-1a2892330b9c?w=600&q=80&auto=format&fit=crop",
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

// Real numbers, computed by actually running a River Overflow scenario
// (bank_rise_m = 1.0 -> water_level_m 522, 11% of the modeled area
// flooded) through this app's own flood engine, then placing a 5-pin
// response plan (evacuation zone, warning point, boat launch, relief/
// medical post, road closure) and running the exact same coverage math
// PlanWorkspace.js uses for the Response Impact Report — against the
// real buildings/facilities/roads data for H-8/H-9. Not invented.
const EXAMPLE = {
  bankRiseM: 1.0,
  waterLevelM: 522,
  floodedPercent: 11,
  atRiskBuildings: 51,
  atRiskPeople: 332,
  floodedRoadSegments: 532,
  before: { evac: 0, warning: 0, rescue: 0, relief: 0, roadsOpen: 532, roadsClosed: 0 },
  after: { evac: 49, warning: 55, rescue: 57, relief: 43, roadsOpen: 531, roadsClosed: 1 },
};

export default function Home() {
  return (
    <div className="bg-ink">
      <SiteNav />

      {/* Hero — 40/60 split */}
      <section className="relative overflow-hidden bg-ink text-paper px-6 py-20 lg:py-28">
        <svg
          className="pointer-events-none absolute inset-0 w-full h-full opacity-25"
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

        <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-12 items-center">
          <div className="lg:col-span-2">
            <h1 className="font-display text-4xl sm:text-5xl font-medium leading-tight">
              <span className="block">Every disaster plan is a guess.</span>
              <span className="block text-flow">Until it&rsquo;s tested.</span>
            </h1>
            <p className="font-body text-lg mt-6 max-w-md opacity-80">
              Run real flood scenarios for Islamabad H-8/H-9, draw your
              response plan, and see the risk change before the water gets
              there.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <GetStartedButton label="Start Your Simulation →" />
              <Link
                href="/how-it-works"
                className="font-body text-sm text-paper/80 hover:text-paper underline underline-offset-4 transition"
              >
                See How It Works
              </Link>
            </div>
          </div>

          <div className="lg:col-span-3">
            <HeroFloodPreview />
          </div>
        </div>
      </section>

      {/* Scenarios — 4 cards, dark palette, lime on hover */}
      <section className="bg-ink px-6 py-16">
        <div className="max-w-6xl mx-auto">
          <h2 className="font-display text-2xl text-paper mb-6">Scenarios Mohafiz models</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {SCENARIOS.map(function (s) {
              return (
                <div
                  key={s.name}
                  className="mh-card mh-fade-in group overflow-hidden border-2 border-mint/30 hover:border-flow rounded-xl bg-surface"
                >
                  <div className="relative h-32 overflow-hidden">
                    <img
                      src={s.image}
                      alt=""
                      className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-110"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/10 to-transparent" />
                  </div>
                  <div className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-line group-hover:bg-flow transition-colors" />
                      <h3 className="font-display text-lg text-paper">{s.name}</h3>
                    </div>
                    <p className="font-body text-sm text-mint mt-2">{s.line}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Flood context — real, sourced numbers only */}
      <section className="bg-ink px-6 py-20">
        <div className="max-w-4xl mx-auto mh-card mh-fade-in border-t-2 border-alert bg-surface rounded-2xl px-8 py-12">
          <div className="font-body text-xs font-semibold tracking-wide text-alert uppercase">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-alert mr-2 align-middle" />
            This isn&rsquo;t rare — it&rsquo;s annual
          </div>
          <h2 className="font-display text-3xl mt-2 text-paper">The Real Story</h2>
          <p className="font-body text-xs text-mint mb-10 mt-1">
            Pakistan&rsquo;s 2025 monsoon season, by the numbers — NDMA / OCHA.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-10">
            <div className="text-center">
              <div className="font-mono text-4xl sm:text-5xl font-medium text-alert">
                <CountUpNumber end={1037} suffix="+" />
              </div>
              <div className="font-body text-xs text-mint mt-2">Lives lost</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-4xl sm:text-5xl font-medium text-alert">
                <CountUpNumber end={6.9} decimals={1} suffix="M" />
              </div>
              <div className="font-body text-xs text-mint mt-2">People affected</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-4xl sm:text-5xl font-medium text-alert">
                <CountUpNumber end={229700} suffix="+" />
              </div>
              <div className="font-body text-xs text-mint mt-2">Homes damaged or destroyed</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-4xl sm:text-5xl font-medium text-alert">
                <CountUpNumber end={3} suffix="M" />
              </div>
              <div className="font-body text-xs text-mint mt-2">People displaced</div>
            </div>
          </div>

          <p className="font-body text-base leading-relaxed text-mint">
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

      {/* Start with "what if" — reframed under a stronger header */}
      <section className="bg-ink px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-8">
            <div>
              <div className="font-body text-xs font-semibold tracking-wide text-flow uppercase">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-flow mr-2 align-middle" />
                Try the thinking
              </div>
              <h2 className="font-display text-3xl text-paper mt-2">From guesswork to a tested plan.</h2>
            </div>
            <p className="font-body text-sm text-mint max-w-xs sm:text-right">
              Every useful plan begins somewhere specific.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
            <div className="mh-card mh-fade-in bg-surface text-paper rounded-2xl px-6 py-6">
              <span className="inline-block font-body text-[10px] font-semibold tracking-wide uppercase bg-paper/10 text-paper/70 rounded-full px-3 py-1">
                A question for Mohafiz
              </span>
              <h3 className="font-display text-xl mt-4">What if the nullah rises 1 metre?</h3>
              <div className="flex flex-wrap gap-2 mt-5">
                <span className="font-body text-xs bg-flow text-ink rounded-full px-3 py-1.5">
                  What if the nullah rises 1 metre?
                </span>
                <span className="font-body text-xs bg-paper/10 text-paper/80 rounded-full px-3 py-1.5">
                  Which roads stay open near H-9?
                </span>
                <span className="font-body text-xs bg-paper/10 text-paper/80 rounded-full px-3 py-1.5">
                  Where should our community shelter?
                </span>
              </div>
              <Link
                href="/how-it-works"
                className="inline-block mt-5 font-body text-sm text-flow hover:opacity-80 transition"
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
                      <h4 className="font-display text-base text-paper">{step.title}</h4>
                      <p className="font-body text-sm text-mint mt-1">{step.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Real before/after example — genuine app output, clearly labeled */}
      <section className="bg-ink px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="font-body text-xs font-semibold tracking-wide text-flow uppercase mb-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-flow mr-2 align-middle" />
            A worked example, not a projection
          </div>
          <h2 className="font-display text-3xl text-paper mb-2">
            Example: a River Overflow response plan we tested.
          </h2>
          <p className="font-body text-sm text-mint mb-10 max-w-2xl">
            A real 1.0m nullah rise ({EXAMPLE.waterLevelM}m water level, {EXAMPLE.floodedPercent}% of
            the modeled area flooded) run through Mohafiz&rsquo;s own engine, then a real 5-action
            response plan tested against it — evacuation zone, warning point, boat launch, relief/medical
            post, and one road closure. These are this app&rsquo;s own computed numbers, not an
            illustration.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="mh-card mh-fade-in border-t-2 border-alert bg-surface rounded-2xl px-8 py-8">
              <div className="font-body text-xs font-semibold tracking-wide text-alert uppercase mb-6">
                Before — no plan placed
              </div>
              <div className="space-y-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Evacuation zone coverage</span>
                  <span className="font-mono text-2xl text-alert">{EXAMPLE.before.evac}%</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Warning range</span>
                  <span className="font-mono text-2xl text-alert">{EXAMPLE.before.warning}%</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Rescue-staging reach</span>
                  <span className="font-mono text-2xl text-alert">{EXAMPLE.before.rescue}%</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Relief / medical reach</span>
                  <span className="font-mono text-2xl text-alert">{EXAMPLE.before.relief}%</span>
                </div>
                <div className="flex items-baseline justify-between pt-3 border-t border-line">
                  <span className="font-body text-sm text-mint">Flooded roads</span>
                  <span className="font-mono text-base text-alert">
                    {EXAMPLE.before.roadsOpen} open, {EXAMPLE.before.roadsClosed} closed
                  </span>
                </div>
              </div>
            </div>

            <div className="mh-card mh-fade-in border-t-2 border-flow bg-surface rounded-2xl px-8 py-8">
              <div className="font-body text-xs font-semibold tracking-wide text-flow uppercase mb-6">
                After — 5-action response plan
              </div>
              <div className="space-y-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Evacuation zone coverage</span>
                  <span className="font-mono text-2xl text-flow">
                    <CountUpNumber end={EXAMPLE.after.evac} suffix="%" />
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Warning range</span>
                  <span className="font-mono text-2xl text-flow">
                    <CountUpNumber end={EXAMPLE.after.warning} suffix="%" />
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Rescue-staging reach</span>
                  <span className="font-mono text-2xl text-flow">
                    <CountUpNumber end={EXAMPLE.after.rescue} suffix="%" />
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="font-body text-sm text-mint">Relief / medical reach</span>
                  <span className="font-mono text-2xl text-flow">
                    <CountUpNumber end={EXAMPLE.after.relief} suffix="%" />
                  </span>
                </div>
                <div className="flex items-baseline justify-between pt-3 border-t border-line">
                  <span className="font-body text-sm text-mint">Flooded roads</span>
                  <span className="font-mono text-base text-flow">
                    {EXAMPLE.after.roadsOpen} open, {EXAMPLE.after.roadsClosed} closed
                  </span>
                </div>
              </div>
            </div>
          </div>

          <p className="font-body text-xs text-mint/70 mt-4">
            {EXAMPLE.atRiskBuildings} buildings (~{EXAMPLE.atRiskPeople} people) were at risk in this run,
            out of {EXAMPLE.floodedRoadSegments} flooded road segments modeled across the sector — one
            local plan doesn&rsquo;t cover a whole basin, and this example says so plainly.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-ink px-6 py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="font-display text-3xl sm:text-4xl text-paper">
            Don&rsquo;t wait for the disaster to test your plan.
          </h2>
          <p className="font-body text-base text-mint mt-4 max-w-xl mx-auto">
            Build a scenario. Test your response. Make the next decision
            better.
          </p>
          <div className="mt-8 flex justify-center">
            <GetStartedButton label="Launch Mohafiz →" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
