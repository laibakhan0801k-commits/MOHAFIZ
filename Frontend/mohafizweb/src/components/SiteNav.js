"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthNavLink from "@/components/AuthNavLink";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/how-it-works", label: "How it Works" },
  { href: "/my-plans", label: "My Plans" },
];

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-20 bg-paper/90 backdrop-blur border-b border-line/25">
      <div className="max-w-5xl mx-auto px-6 py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <Link href="/" className="font-display text-lg font-medium text-ink justify-self-start">
          Mohafiz
        </Link>

        <div className="justify-self-center flex flex-nowrap items-center gap-1 bg-white/60 rounded-full px-1.5 py-1.5 font-body text-sm whitespace-nowrap">
          {NAV_LINKS.map(function (item) {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "px-3.5 py-1.5 rounded-full transition " +
                  (active ? "bg-lime text-ink font-medium" : "text-ink/70 hover:text-ink")
                }
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="justify-self-end">
          <AuthNavLink />
        </div>
      </div>
    </nav>
  );
}
