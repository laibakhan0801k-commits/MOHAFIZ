"use client";

import { useRouter } from "next/navigation";

export default function GetStartedButton({ label = "Get Started", variant = "lime", className = "" }) {
  const router = useRouter();

  function handleClick() {
    const loggedIn = !!localStorage.getItem("mohafiz_token");
    router.push(loggedIn ? "/map" : "/login");
  }

  // "dark" used to mean a dark button on the old light page — now that
  // ink is the page background everywhere, that would be invisible, so
  // it's a bordered surface-toned secondary button instead. "lime" (the
  // default) stays the one high-contrast primary-CTA treatment.
  const colors =
    variant === "dark"
      ? "bg-surface text-paper border border-line hover:border-flow"
      : "bg-flow text-ink";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        colors +
        " font-body text-sm px-6 py-3 rounded-full shadow-md hover:opacity-90 hover:-translate-y-0.5 hover:shadow-lg transition inline-flex items-center gap-1.5 " +
        className
      }
    >
      {label}
      {variant === "dark" && <span aria-hidden="true">↗</span>}
    </button>
  );
}
