import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

// Pakistan's nationwide emergency short codes. Only numbers that are
// national short codes are listed -- a wrong digit on this page is worse
// than an absent entry, so no city landline is included on trust.
// `dial` is what actually goes in the tel: href; `number` is what a
// person reads.
const PRIMARY = {
  number: "1122",
  dial: "1122",
  name: "Rescue 1122",
  detail:
    "Pakistan's emergency service — ambulance, water rescue and disaster response on one number. Operates in Punjab, Islamabad, Khyber Pakhtunkhwa, AJK and Gilgit-Baltistan.",
};

const SERVICES = [
  {
    number: "15",
    dial: "15",
    name: "Police",
    detail: "Police emergency helpline (Madadgar), nationwide.",
  },
  {
    number: "115",
    dial: "115",
    name: "Edhi Ambulance",
    detail: "Edhi Foundation's free ambulance service, nationwide.",
  },
  {
    number: "1020",
    dial: "1020",
    name: "Chhipa Ambulance",
    detail: "Chhipa Welfare ambulance service, mainly Sindh and Karachi.",
  },
  {
    number: "130",
    dial: "130",
    name: "Motorway Police",
    detail: "National Highways & Motorway Police, for motorway incidents.",
  },
];

// Administrative lines, not dispatch numbers -- for reporting, coordination
// and advance flood warnings, not for someone in immediate danger (that's
// what SERVICES above is for). NDMA's UAN is published on its own official
// site (ndma.gov.pk/contact); PDMA Punjab covers Rawalpindi/Islamabad,
// where this project's Nullah Leh / Korang Nullah corridor actually is --
// PDMA Sindh is a different province's authority and is left out on
// purpose, not missed.
const AUTHORITIES = [
  {
    number: "051-111-157-157",
    dial: "051111157157",
    name: "NDMA",
    detail: "National Disaster Management Authority — national coordination.",
  },
  {
    number: "042-99204408",
    dial: "04299204408",
    name: "PDMA Punjab",
    detail: "Provincial Disaster Management Authority — covers Rawalpindi/Islamabad.",
  },
];

function PhoneIcon({ className }) {
  return (
    <svg
      className={className}
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />
    </svg>
  );
}

export default function ContactPage() {
  return (
    <div className="bg-ink flex flex-col min-h-screen">
      <SiteNav />

      <section className="bg-ink px-6 py-16 flex-1">
        <div className="max-w-4xl mx-auto">
          <h1 className="font-display text-4xl font-medium text-paper">
            Emergency Contacts
          </h1>
          <p className="font-body text-sm text-mint mt-2">
            Tap any number to call it directly. These are Pakistan&apos;s national
            emergency short codes — free to dial from any phone.
          </p>

          {/* Rescue 1122 gets the whole width and the alert colour: in a real
              flood it is the number that matters, and it should never be one
              tile among six identical ones. */}
          <a
            href={"tel:" + PRIMARY.dial}
            aria-label={"Call " + PRIMARY.name + " on " + PRIMARY.number}
            className="mh-card mh-fade-in block bg-surface border-l-4 border-alert rounded-2xl px-9 py-9 mt-10 hover:border-flow transition-colors"
          >
            <div className="flex items-center gap-4">
              <PhoneIcon className="w-8 h-8 stroke-alert shrink-0" />
              <div>
                <div className="font-body text-xs uppercase tracking-widest text-alert">
                  Call first in an emergency
                </div>
                <div className="font-mono text-7xl font-medium text-paper leading-none mt-2">
                  {PRIMARY.number}
                </div>
              </div>
            </div>
            <div className="font-display text-xl text-paper mt-5">{PRIMARY.name}</div>
            <p className="font-body text-sm leading-relaxed text-mint mt-2">
              {PRIMARY.detail}
            </p>
          </a>

          <h2 className="font-display text-lg text-paper mt-14">
            Other emergency numbers
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-5">
            {SERVICES.map(function (s) {
              return (
                <a
                  key={s.number}
                  href={"tel:" + s.dial}
                  aria-label={"Call " + s.name + " on " + s.number}
                  className="mh-card mh-fade-in group block bg-surface rounded-xl border border-line hover:border-flow p-6 transition-colors"
                >
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-4xl font-medium text-flow">
                      {s.number}
                    </span>
                    <span className="font-display text-base text-paper">{s.name}</span>
                  </div>
                  <p className="font-body text-sm leading-relaxed text-mint mt-2">
                    {s.detail}
                  </p>
                  <span className="font-body text-xs text-flow opacity-0 group-hover:opacity-100 transition-opacity mt-3 inline-flex items-center gap-1.5">
                    <PhoneIcon className="w-3.5 h-3.5 stroke-flow" />
                    Tap to call
                  </span>
                </a>
              );
            })}
          </div>

          <h2 className="font-display text-lg text-paper mt-14">
            Flood authorities
          </h2>
          <p className="font-body text-sm text-mint mt-1">
            Administrative lines for coordination and advance warnings — not for
            someone in immediate danger. Call Rescue 1122 for that.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-5">
            {AUTHORITIES.map(function (a) {
              return (
                <a
                  key={a.number}
                  href={"tel:" + a.dial}
                  aria-label={"Call " + a.name + " on " + a.number}
                  className="mh-card mh-fade-in group block bg-surface/60 rounded-xl border border-line hover:border-mint p-6 transition-colors"
                >
                  <div className="font-display text-base text-paper">{a.name}</div>
                  <span className="font-mono text-2xl font-medium text-mint mt-1 block">
                    {a.number}
                  </span>
                  <p className="font-body text-sm leading-relaxed text-mint/80 mt-2">
                    {a.detail}
                  </p>
                  <span className="font-body text-xs text-mint opacity-0 group-hover:opacity-100 transition-opacity mt-3 inline-flex items-center gap-1.5">
                    <PhoneIcon className="w-3.5 h-3.5 stroke-mint" />
                    Tap to call
                  </span>
                </a>
              );
            })}
          </div>

          <div className="mh-card bg-surface border-l-4 border-mint rounded-xl px-7 py-6 mt-12">
            <h2 className="font-display text-base text-paper">
              Mohafiz is not an emergency service
            </h2>
            <p className="font-body text-sm leading-relaxed text-mint mt-2">
              This is a planning and simulation tool. It does not monitor live
              conditions, and it cannot dispatch help. During an actual flood,
              call <span className="font-mono text-paper">1122</span> and follow
              NDMA, PDMA, WASA and local authority instructions.
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
