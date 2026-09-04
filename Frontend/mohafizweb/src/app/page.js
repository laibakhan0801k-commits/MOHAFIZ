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
    image: "https://images.unsplash.com/photo-1604275689235-fdc521556c16?w=900&q=80&auto=format&fit=crop",
  },
  {
    name: "Rainfall",
    line: "Flash flooding when monsoon rain outpaces urban drainage.",
    image: "https://images.unsplash.com/photo-1534862262637-373c120dcbcc?w=900&q=80&auto=format&fit=crop",
  },
  {
    name: "Drainage Failure",
    line: "Blocked drains and encroached nullahs — the most common local cause.",
    image: "https://images.unsplash.com/photo-1576749288264-207936efb479?w=900&q=80&auto=format&fit=crop",
  },
  {
    name: "Dam Release",
    line: "Rawal Dam's spillway releases into Korang Nullah, with real advance warning.",
    image: "https://images.unsplash.com/photo-1639237046487-1a2892330b9c?w=900&q=80&auto=format&fit=crop",
  },
];

const WHAT_IF_STEPS = [
  {
    n: "01",
    title: "See the real flood extent",
    body: "Real elevation data, not an illustration.",
  },
  {
    n: "02",
    title: "Find what actually helps",
    body: "Simulate a real fix, before and after.",
  },
  {
    n: "03",
    title: "Save your plan",
    body: "Keep it in your account — revisit or compare anytime.",
  },
];

const SAMPLE_QUESTIONS = [
  "What if it rains 50mm/hr?",
  "Which roads flood if the dam releases?",
  "What prevention would protect this area?",
];

// Real numbers and real map screenshots, both from an actual run through
// the live app (not the API in isolation): a moderate-rainfall scenario
// (band "moderate", 10.1-30mm/24hr -> water_level_m 511.7, 0.72% of the
// modeled area flooded) with a real 4-action prevention plan placed by
// clicking the actual map — desilt (100m), unblock drain (30m), a tree
// buffer, and a water storage pond (10,000m2, 3m deep) on a genuinely
// flooded pixel near H-9. 130m of waterway is the actual, correctly-
// summed treated length (see flood_engine.compute_capacity_gain). The
// capacity actions alone move flooded%/roads/depth by an amount too
// small to register at pixel resolution — the pond is what makes this
// run's before/after real and non-zero. Screenshots below are the
// literal Before/After panels from that run's own Prevention Impact
// Report. Not invented.
const PREVENTION_EXAMPLE = {
  before: { floodedPercent: 0.72, avgDepthM: 2.53 },
  after: { floodedPercent: 0.69, avgDepthM: 2.49 },
  treatedLengthM: 130,
  areaSavedM2: 4773,
  volumeStoredM3: 30000,
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
              Run real flood scenarios for Islamabad&rsquo;s Nullah Leh /
              Korang Nullah corridor — Saidpur to Blue Area — draw your
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
                  className="mh-card mh-fade-in group border-2 border-mint/30 hover:border-flow rounded-xl bg-surface p-3"
                >
                  <div className="relative h-32 overflow-hidden rounded-lg border border-line">
                    <img
                      src={s.image}
                      alt={s.name}
                      className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-110"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-surface/70 via-transparent to-transparent" />
                  </div>
                  <div className="pt-4">
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

      {/* Start with "what if" — reframed under a stronger header */}
      <section className="bg-ink px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-paper mb-10">
            Ask a real question. Get a real simulation.
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-14 items-start">
            <div className="mh-card mh-fade-in bg-surface text-paper rounded-2xl px-6 py-6">
              <span className="inline-block font-body text-[10px] font-semibold tracking-wide uppercase bg-paper/10 text-paper/70 rounded-full px-3 py-1">
                A question for Mohafiz
              </span>
              <div className="flex flex-col gap-3 mt-5">
                {SAMPLE_QUESTIONS.map(function (q, i) {
                  return (
                    <span
                      key={q}
                      className={
                        "font-body text-sm rounded-full px-5 py-3 " +
                        (i === 0
                          ? "bg-flow text-ink font-semibold"
                          : "bg-paper/10 text-paper/70")
                      }
                    >
                      {q}
                    </span>
                  );
                })}
              </div>
              <Link
                href="/how-it-works"
                className="inline-block mt-5 font-body text-sm text-flow hover:opacity-80 transition"
              >
                See a grounded answer →
              </Link>
            </div>

            <div className="lg:border-l lg:border-line lg:pl-14">
              <div className="space-y-6">
                {WHAT_IF_STEPS.map(function (step) {
                  return (
                    <div key={step.n} className="mh-fade-in flex gap-4">
                      <span className="font-mono text-sm font-semibold text-flow">{step.n}</span>
                      <div>
                        <h4 className="font-display text-base font-bold text-paper">{step.title}</h4>
                        <p className="font-body text-sm text-mint mt-1">{step.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Flood context — real, sourced numbers only */}
      {/* Real before/after prevention-plan example */}
      <section className="bg-ink px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-paper mb-4">
            A real prevention plan we tested.
          </h2>
          <p className="font-body text-sm text-mint mb-10 max-w-2xl">
            A real rainfall scenario ({PREVENTION_EXAMPLE.before.floodedPercent}% of the modeled area
            flooded) run through Mohafiz&rsquo;s own engine, then a real prevention plan — desilting,
            unblocking a drain, a tree buffer, and a small water storage pond,{' '}
            {PREVENTION_EXAMPLE.treatedLengthM}m of waterway actually treated — tested against it. The
            pond alone protects {PREVENTION_EXAMPLE.areaSavedM2.toLocaleString()} m² and intercepts{' '}
            {PREVENTION_EXAMPLE.volumeStoredM3.toLocaleString()} m³ before it reaches the floodplain.
            These are this app&rsquo;s own computed numbers, not an illustration.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="mh-card mh-fade-in bg-surface rounded-2xl overflow-hidden">
              <div className="px-6 pt-6">
                <div className="flex items-center gap-2 font-body text-sm font-semibold text-alert">
                  <span className="w-2 h-2 rounded-full bg-alert" />
                  Before (no prevention)
                </div>
              </div>
              <div className="mx-6 mt-4 h-52 overflow-hidden rounded-xl border border-line">
                <img
                  src="/images/prevention-before.png"
                  alt="Before prevention — flood extent map"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="mt-6 grid grid-cols-2 divide-x divide-line border-t border-line">
                <div className="px-6 py-4">
                  <div className="font-body text-xs text-mint/70">Flooded</div>
                  <div className="font-mono text-xl font-bold text-paper">{PREVENTION_EXAMPLE.before.floodedPercent}%</div>
                </div>
                <div className="px-6 py-4">
                  <div className="font-body text-xs text-mint/70">Avg depth</div>
                  <div className="font-mono text-xl font-bold text-paper">{PREVENTION_EXAMPLE.before.avgDepthM}m</div>
                </div>
              </div>
            </div>

            <div className="mh-card mh-fade-in bg-surface rounded-2xl overflow-hidden">
              <div className="px-6 pt-6">
                <div className="flex items-center gap-2 font-body text-sm font-semibold text-flow">
                  <span className="w-2 h-2 rounded-full bg-flow" />
                  After (with prevention)
                </div>
              </div>
              <div className="mx-6 mt-4 h-52 overflow-hidden rounded-xl border border-line">
                <img
                  src="/images/prevention-after.png"
                  alt="After prevention — reduced flood extent map"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="mt-6 grid grid-cols-2 divide-x divide-line border-t border-line">
                <div className="px-6 py-4">
                  <div className="font-body text-xs text-mint/70">Flooded</div>
                  <div className="font-mono text-xl font-bold text-flow">
                    <CountUpNumber end={PREVENTION_EXAMPLE.after.floodedPercent} decimals={2} suffix="%" />
                  </div>
                </div>
                <div className="px-6 py-4">
                  <div className="font-body text-xs text-mint/70">Avg depth</div>
                  <div className="font-mono text-xl font-bold text-flow">
                    <CountUpNumber end={PREVENTION_EXAMPLE.after.avgDepthM} decimals={2} suffix="m" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* This exact corridor's own flood history — not national stats */}
      <section className="bg-ink px-6 py-20">
        <div className="max-w-5xl mx-auto mh-card mh-fade-in bg-surface rounded-2xl px-8 py-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
            <div>
              <div className="relative h-64 overflow-hidden rounded-xl border border-line">
                <img
                  src="https://upload.wikimedia.org/wikipedia/commons/f/fe/Lai_Nullah.JPG"
                  alt="Nullah Leh in Rawalpindi"
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="font-body text-xs text-mint/60 mt-3 text-center">
                Nullah Leh, Rawalpindi — the actual channel this corridor is built around.
              </p>
              <p className="font-body text-xs text-mint/60 mt-1 text-center">
                Photo: Faizan Sh,{" "}
                <a
                  href="https://commons.wikimedia.org/wiki/File:Lai_Nullah.JPG"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-mint"
                >
                  Wikimedia Commons
                </a>
                , CC BY-SA 4.0.
              </p>
            </div>

            <div>
              <h2 className="font-display text-3xl text-paper">The Real Story</h2>
              <p className="font-body text-base leading-relaxed text-mint mt-5">
                Nullah Leh, Korang Nullah — the exact corridor this project simulates.
              </p>
              <p className="font-body text-base leading-relaxed text-mint mt-4">
                This corridor has flooded before — documented events in{" "}
                <span className="font-mono font-medium text-alert">2001, 2008, 2023, and 2025</span>.
                In August 2026, Saidpur recorded{" "}
                <span className="font-mono font-medium text-alert">85mm</span> of rain and Rawal Dam —
                on the Korang River, part of this project&rsquo;s own named corridor — opened its
                spillway at <span className="font-mono font-medium text-alert">99.8%</span> capacity.
                A 2020 budget of <span className="font-mono font-medium text-alert">Rs40M</span> to
                desilt Nullah Leh came with a warning: a 12ft rise if it didn&rsquo;t happen. This
                isn&rsquo;t a hypothetical corridor — it&rsquo;s the one Mohafiz actually models.
              </p>
            </div>
          </div>
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
