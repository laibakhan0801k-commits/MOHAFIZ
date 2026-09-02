"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// Real bounds of the H-8/H-9 study area this app actually models (same
// box HeroFloodPreview.js uses for its overlay) — not placeholder
// coordinates.
const BBOX = { north: 33.7351, south: 33.6701, east: 73.0849, west: 73.0099 };

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(null);

  useEffect(() => {
    if (localStorage.getItem("mohafiz_token")) {
      router.replace("/");
    }
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("loading");
    setMessage("");
    setToken(null);

    try {
      const res = await fetch(API_URL + "/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || "Something went wrong.");
      }

      if (mode === "login") {
        setToken(data.access_token);
        setStatus("success");
        setMessage("Logged in. Redirecting...");
        localStorage.setItem("mohafiz_token", data.access_token);
        localStorage.setItem(
          "mohafiz_user",
          JSON.stringify({ id: data.user_id, email: data.email })
        );
        router.push("/");
      } else {
        setStatus("success");
        setMessage("Account created — you can log in now.");
        setMode("login");
        setPassword("");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err.message);
    }
  }

  return (
    <div className="flex min-h-screen w-full bg-ink text-paper">
      <div className="relative hidden w-1/2 overflow-hidden bg-ink md:flex md:flex-col md:justify-between md:p-12">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-25"
          viewBox="0 0 800 900"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M-20,140 C120,90 260,190 400,150 C540,110 660,200 820,150" className="stroke-flow" strokeWidth="1" fill="none" />
          <path d="M-20,230 C140,180 260,270 420,230 C560,195 680,270 820,230" className="stroke-flow" strokeWidth="1" fill="none" opacity="0.7" />
          <path d="M-20,330 C130,290 280,360 420,320 C560,280 700,350 820,320" className="stroke-line" strokeWidth="1" fill="none" opacity="0.6" />
          <path d="M-20,430 C150,400 260,460 420,430 C580,400 680,460 820,430" className="stroke-line" strokeWidth="1" fill="none" opacity="0.5" />
          <path d="M-20,540 C140,510 280,570 420,540 C560,510 690,570 820,540" className="stroke-flow" strokeWidth="1" fill="none" opacity="0.3" />
          <path d="M-20,650 C150,620 280,680 420,650 C570,620 690,680 820,650" className="stroke-line" strokeWidth="1" fill="none" opacity="0.25" />
        </svg>

        <div className="relative z-10 flex-1 flex flex-col justify-center py-10">
          <h1 className="font-display text-5xl lg:text-6xl font-bold tracking-tight text-paper">
            MOHAFIZ
          </h1>
          <p className="mt-2 font-display text-sm font-semibold uppercase tracking-wide text-flow">
            Pakistan&rsquo;s What IF Engine
          </p>
          <p className="mt-4 max-w-sm font-body text-base leading-relaxed text-mint">
            Flood response digital twin for the Nullah Leh / Korang Nullah
            corridor — Saidpur to Blue Area, Islamabad.
          </p>
        </div>

        <div className="relative z-10 font-mono text-xs text-mint/70">
          <div className="mb-1 text-mint/50">BOUNDING BOX</div>
          <div>N {BBOX.north.toFixed(4)}&deg; &nbsp; S {BBOX.south.toFixed(4)}&deg;</div>
          <div>E {BBOX.east.toFixed(4)}&deg; &nbsp; W {BBOX.west.toFixed(4)}&deg;</div>
        </div>
      </div>

      <div className="flex w-full flex-col items-center justify-center px-6 py-16 md:w-1/2 bg-surface-2">
        <div className="w-full max-w-sm">
          <div className="mb-8 md:hidden">
            <Logo />
          </div>

          <div className="mb-8 flex gap-1 rounded-lg border border-line bg-ink/30 p-1">
            <button
              type="button"
              onClick={function () { setMode("login"); setStatus("idle"); setMessage(""); }}
              className={"flex-1 rounded-md py-2 font-body text-sm font-medium transition-colors " + (mode === "login" ? "bg-flow text-ink" : "text-mint hover:text-paper")}
            >
              Log in
            </button>
            <button
              type="button"
              onClick={function () { setMode("signup"); setStatus("idle"); setMessage(""); }}
              className={"flex-1 rounded-md py-2 font-body text-sm font-medium transition-colors " + (mode === "signup" ? "bg-flow text-ink" : "text-mint hover:text-paper")}
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block font-body text-xs font-medium text-mint">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={function (e) { setEmail(e.target.value); }}
                className="w-full rounded-lg border border-line bg-ink/30 px-3.5 py-2.5 font-body text-sm text-paper outline-none placeholder:text-mint/40 focus:border-flow focus:ring-2 focus:ring-flow/20"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block font-body text-xs font-medium text-mint">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={function (e) { setPassword(e.target.value); }}
                className="w-full rounded-lg border border-line bg-ink/30 px-3.5 py-2.5 font-body text-sm text-paper outline-none placeholder:text-mint/40 focus:border-flow focus:ring-2 focus:ring-flow/20"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg bg-flow py-2.5 font-body text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {status === "loading" ? "Working..." : mode === "login" ? "Log In" : "Create account"}
            </button>
          </form>

          {message && (
            <div
              className={"mt-4 rounded-lg border px-3.5 py-2.5 font-body text-sm " + (status === "error" ? "border-alert/30 bg-alert/10 text-alert" : "border-flow/30 bg-flow/10 text-flow")}
            >
              {message}
            </div>
          )}

          {token && (
            <div className="mt-3 rounded-lg border border-line bg-ink/30 px-3.5 py-2.5 font-mono text-xs text-mint">
              token: {token.slice(0, 24)}...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
