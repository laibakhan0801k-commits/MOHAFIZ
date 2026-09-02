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
    image: "https://images.unsplash.com/photo-1657579386421-98ca5462e3cf?w=800&q=80&auto=format&fit=crop",
    body: "Islamabad and Rawalpindi don't flood for one reason — they flood for four: a river breaching its banks, monsoon rain outrunning the drains, storm drains blocked by decades of encroachment and waste, and scheduled water releases from Rawal Dam into Korang Nullah. Mohafiz exists because most flood-planning tools model only one of these, if any at all.",
  },
  {
    title: "What grounds it",
    icon: "layers",
    iconColor: "stroke-flow",
    image: "https://images.unsplash.com/photo-1769184615939-00913575f62a?w=800&q=80&auto=format&fit=crop",
    body: "Every scenario in Mohafiz is built on real inputs: elevation data for the H-8/H-9 sector, the actual road network, Pakistan Meteorological Department's own rainfall intensity bands, and documented statements from WASA and the CDA on what causes local drainage failure. The dam release scenario mirrors Rawal Dam's real, publicly logged spillway protocol — including the siren warnings issued before every release.",
  },
  {
    title: "Limitations",
    icon: "alert",
    iconColor: "stroke-mint",
    image: "https://images.unsplash.com/photo-1648128827832-1e8a90442b07?w=800&q=80&auto=format&fit=crop",
    body: "Mohafiz is a planning and simulation tool, not an official emergency alert system. It's built to help teams think through response and prevention plans in advance — not to replace guidance from NDMA, WASA, or local authorities during an actual flood.",
  },
  {
    title: "Data sources",
    icon: "sources",
    iconColor: "stroke-mint",
    image: "https://images.unsplash.com/photo-1583521214690-73421a1829a9?w=800&q=80&auto=format&fit=crop",
    body: "Elevation / DEM data, the OpenStreetMap road network, PMD rainfall classifications, and public reporting on Rawal Dam operations. Exact source links to be added here.",
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
                className="mh-card mh-fade-in group bg-surface rounded-xl overflow-hidden border border-line hover:border-flow"
              >
                <div className="relative h-32 overflow-hidden">
                  <img
                    src={s.image}
                    alt=""
                    className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-110"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/10 to-transparent" />
                </div>
                <div className="px-5 py-5">
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
