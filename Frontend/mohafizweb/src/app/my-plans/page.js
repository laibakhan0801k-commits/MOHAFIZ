import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

export default function MyPlansPage() {
  return (
    <div className="bg-paper flex flex-col min-h-screen">
      <SiteNav />
      <section className="bg-paper px-6 py-24 flex-1 flex items-center justify-center text-center">
        <div className="mh-card mh-fade-in bg-white/70 border-l-4 border-alert rounded-xl px-10 py-10">
          <h1 className="font-display text-2xl text-ink">My Plans</h1>
          <p className="font-body text-sm text-ink/70 mt-3">This page is coming soon.</p>
          <Link href="/" className="font-body text-sm text-flow underline mt-6 inline-block">
            ← Back to home
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
