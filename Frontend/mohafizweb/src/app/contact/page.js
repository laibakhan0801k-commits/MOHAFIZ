import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

export default function ContactPage() {
  return (
    <div className="bg-ink flex flex-col min-h-screen">
      <SiteNav />
      <section className="bg-ink px-6 py-24 flex-1 flex items-center justify-center text-center">
        <div className="mh-card mh-fade-in bg-surface border-l-4 border-flow rounded-xl px-10 py-10">
          <h1 className="font-display text-2xl text-paper">Contact</h1>
          <p className="font-body text-sm text-mint mt-3">This page is coming soon.</p>
          <Link href="/" className="font-body text-sm text-flow underline mt-6 inline-block">
            ← Back to home
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
