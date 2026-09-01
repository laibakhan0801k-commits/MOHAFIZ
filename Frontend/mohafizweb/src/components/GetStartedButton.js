"use client";

import { useRouter } from "next/navigation";

export default function GetStartedButton({ label = "Get Started", variant = "lime", className = "" }) {
  const router = useRouter();

  function handleClick() {
    const loggedIn = !!localStorage.getItem("mohafiz_token");
    router.push(loggedIn ? "/map" : "/login");
  }

  const colors = variant === "dark" ? "bg-ink text-paper" : "bg-lime text-ink";

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
