"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthNavLink from "@/components/AuthNavLink";
import { LogoMark } from "@/components/Logo";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/how-it-works", label: "How it Works" },
  { href: "/my-plans", label: "My Plans" },
];

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-20 bg-ink/90 backdrop-blur border-b border-line/25">
      <div className="max-w-5xl mx-auto px-6 py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <Link href="/" className="flex items-center gap-2 font-display text-lg font-medium text-paper justify-self-start">
          <LogoMark className="w-7 h-7" />
          Mohafiz
        </Link>

        <div className="justify-self-center flex flex-nowrap items-center gap-1 bg-surface/60 rounded-full px-1.5 py-1.5 font-body text-sm whitespace-nowrap">
          {NAV_LINKS.map(function (item) {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "px-3.5 py-1.5 rounded-full transition " +
                  (active ? "bg-flow text-ink font-medium" : "text-paper/70 hover:text-paper")
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
