import Link from "next/link";
import { LogoMark } from "@/components/Logo";

const FOOTER_LINKS = [
  { href: "/", label: "Home" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About Mohafiz" },
  { href: "/contact", label: "Contact" },
];

export default function SiteFooter() {
  return (
    <footer className="bg-ink text-paper">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <LogoMark className="w-6 h-6" />
              <span className="font-display text-base font-medium">mohafiz</span>
            </div>
            <p className="font-body text-sm text-paper/60 mt-3 max-w-xs">
              Turning uncertainty into a little more readiness, one place at a time.
            </p>
          </div>

          <div className="flex flex-wrap gap-6 font-body text-sm">
            {FOOTER_LINKS.map(function (item) {
              return (
                <Link key={item.href} href={item.href} className="text-paper/70 hover:text-paper transition">
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-10 pt-6 border-t border-paper/10">
          <span className="font-body text-[11px] tracking-wide uppercase text-paper/40">
            Built for a safer Pakistan
          </span>
          <span className="font-body text-xs text-paper/50">
            Mohafiz — for real emergencies call Rescue 1122.
          </span>
        </div>
      </div>
    </footer>
  );
}
