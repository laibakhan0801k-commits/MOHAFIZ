import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

const STATS = [
  {
    icon: "wave",
    value: "146mm",
    label: "Real rainfall recorded at Golra, Aug 2026",
  },
  {
    icon: "home",
    value: "4",
    label: "Real flood causes modeled separately",
  },
  {
    icon: "clock",
    value: "2007",
    label: "Real siren warning system this project's warning-gauge action is modeled on",
  },
  {
    icon: "shield",
    value: "Rs40M",
    label: "Real 2020 desilting budget for this corridor",
  },
];

function StatIcon({ name }) {
  const common = {
    className: "w-9 h-9 stroke-flow",
    fill: "none",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  };

  if (name === "wave") {
    return (
      <svg {...common}>
        <path d="M2 9c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0" />
        <path d="M2 15c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0" />
      </svg>
    );
  }
  if (name === "home") {
    return (
      <svg {...common}>
        <path d="M4 11.5 12 4l8 7.5" />
        <path d="M6 10v9h12v-9" />
        <path d="M10 19v-5h4v5" />
      </svg>
    );
  }
  if (name === "clock") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    );
  }
  if (name === "shield") {
    return (
      <svg {...common}>
        <path d="M12 3.5 19 6.5v5c0 5-3 8.2-7 9.5-4-1.3-7-4.5-7-9.5v-5Z" />
      </svg>
    );
  }
  return null;
}

function SectionIcon({ name, colorClass }) {
  const common = {
    className: "w-7 h-7 " + colorClass,
    fill: "none",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  };

  if (name === "causes") {
    return (
      <svg {...common}>
        <path d="M12 3c2.5 3.2 4 5.7 4 7.8a4 4 0 1 1-8 0C8 8.7 9.5 6.2 12 3Z" />
        <circle cx="18.5" cy="16.5" r="2" />
        <circle cx="5.5" cy="16.5" r="2" />
      </svg>
    );
  }
  if (name === "layers") {
    return (
      <svg {...common}>
        <path d="m12 3 9 4.5-9 4.5-9-4.5 9-4.5Z" />
        <path d="m3 12 9 4.5 9-4.5" />
        <path d="m3 16.5 9 4.5 9-4.5" />
      </svg>
    );
  }
  if (name === "alert") {
    return (
      <svg {...common}>
        <path d="M12 4 21.5 20h-19L12 4Z" />
        <path d="M12 10v4" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "sources") {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="6" rx="7" ry="2.5" />
        <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
        <path d="M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
      </svg>
    );
  }
  return null;
}

const SECTIONS = [
  {
    title: "Why Mohafiz exists",
    icon: "causes",
    iconColor: "stroke-flow",
    image: "https://images.unsplash.com/photo-1761252987116-a3e993bd23e9?w=900&q=80&auto=format&fit=crop",
    body: "Islamabad and Rawalpindi flood for four different reasons — a river breaching its banks, monsoon rain outrunning the drains, storm drains blocked by encroachment, and scheduled Rawal Dam releases. Most tools model only one.",
  },
  {
    title: "What grounds it",
    icon: "layers",
    iconColor: "stroke-flow",
    image: "https://images.unsplash.com/photo-1441644599508-24ae08965c5c?w=900&q=80&auto=format&fit=crop",
    body: "Every scenario runs on real inputs: elevation data for the Nullah Leh / Korang Nullah corridor, the actual road network, PMD rainfall bands, and documented WASA/CDA drainage reports. The dam scenario mirrors Rawal Dam's real spillway protocol, sirens included.",
  },
  {
    title: "Limitations",
    icon: "alert",
    iconColor: "stroke-mint",
    image: "https://images.unsplash.com/photo-1755052411125-42bbfd87588b?w=900&q=80&auto=format&fit=crop",
    body: "Mohafiz is a planning and simulation tool, not an emergency alert system. Use it to prepare response plans in advance — not as a replacement for NDMA, WASA, or local authority guidance during an actual flood.",
  },
  {
    title: "Data sources",
    icon: "sources",
    iconColor: "stroke-mint",
    image: "https://images.unsplash.com/photo-1756093158082-37e567772896?w=900&q=80&auto=format&fit=crop",
    body: "Elevation (DEM) data, the OpenStreetMap road network, PMD rainfall classifications, and public reporting on Rawal Dam operations. Source links coming soon.",
  },
];

export default function AboutPage() {
  return (
    <div className="bg-ink">
      <SiteNav />

      <section className="bg-ink px-6 py-16">
        <div className="max-w-4xl mx-auto">
          <h1 className="font-display text-4xl font-medium text-paper">About Mohafiz</h1>
          <p className="font-body text-sm text-mint mt-2 mb-10">
            Built on real, documented sources — not estimates
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-14">
            {STATS.map(function (s) {
              return (
                <div
                  key={s.label}
                  className="mh-card mh-fade-in bg-surface rounded-2xl px-9 py-9"
                >
                  <StatIcon name={s.icon} />
                  <div className="font-mono text-6xl font-medium text-flow mt-5">{s.value}</div>
                  <p className="font-body text-base text-mint mt-3">{s.label}</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {SECTIONS.map(function (s) {
            return (
              <div
                key={s.title}
                className="mh-card mh-fade-in group bg-surface rounded-xl border border-line hover:border-flow p-4"
              >
                <div className="relative h-40 overflow-hidden rounded-lg border border-line">
                  <img
                    src={s.image}
                    alt={s.title}
                    className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-110"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-surface/70 via-transparent to-transparent" />
                </div>
                <div className="pt-5">
                  <SectionIcon name={s.icon} colorClass={s.iconColor} />
                  <h2 className="font-display text-lg text-paper mt-3">{s.title}</h2>
                  <p className="font-body text-sm leading-relaxed text-mint mt-2">{s.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
