import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

const SECTIONS = [
  {
    title: "Why Mohafiz exists",
    border: "border-flow",
    body: "Islamabad and Rawalpindi don't flood for one reason — they flood for four: a river breaching its banks, monsoon rain outrunning the drains, storm drains blocked by decades of encroachment and waste, and scheduled water releases from Rawal Dam into Korang Nullah. Mohafiz exists because most flood-planning tools model only one of these, if any at all.",
  },
  {
    title: "What grounds it",
    border: "border-flow",
    body: "Every scenario in Mohafiz is built on real inputs: elevation data for the H-8/H-9 sector, the actual road network, Pakistan Meteorological Department's own rainfall intensity bands, and documented statements from WASA and the CDA on what causes local drainage failure. The dam release scenario mirrors Rawal Dam's real, publicly logged spillway protocol — including the siren warnings issued before every release.",
  },
  {
    title: "Limitations",
    border: "border-alert",
    body: "Mohafiz is a planning and simulation tool, not an official emergency alert system. It's built to help teams think through response and prevention plans in advance — not to replace guidance from NDMA, WASA, or local authorities during an actual flood.",
  },
  {
    title: "Data sources",
    border: "border-line",
    body: "Elevation / DEM data, the OpenStreetMap road network, PMD rainfall classifications, and public reporting on Rawal Dam operations. Exact source links to be added here.",
  },
  {
    title: "The team",
    border: "border-line",
    body: "Names and bios to be added here.",
  },
];

export default function AboutPage() {
  return (
    <div className="bg-ink">
      <SiteNav />

      <section className="bg-ink px-6 py-16">
        <div className="max-w-2xl mx-auto">
          <h1 className="font-display text-4xl font-medium text-paper mb-10">About Mohafiz</h1>

          <div className="space-y-6">
            {SECTIONS.map(function (s) {
              return (
                <div
                  key={s.title}
                  className={"mh-card mh-fade-in border-l-4 " + s.border + " bg-surface rounded-xl px-6 py-5"}
                >
                  <h2 className="font-display text-lg text-paper">{s.title}</h2>
                  <p className="font-body text-sm leading-relaxed text-mint mt-2">{s.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
