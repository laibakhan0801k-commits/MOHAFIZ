"use client";

import { useState } from "react";
import { Space_Grotesk } from "next/font/google";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
});

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export default function Home() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(null);

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
        setMessage("Logged in.");
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
    <div className="flex min-h-screen w-full bg-[#080D18] text-[#E7EEF7]">
      <div className="relative hidden w-1/2 overflow-hidden bg-gradient-to-br from-[#0B1220] to-[#0F1E30] md:flex md:flex-col md:justify-between md:p-12">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.18]"
          viewBox="0 0 800 900"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M-20,140 C120,90 260,190 400,150 C540,110 660,200 820,150" stroke="#2DD4BF" strokeWidth="1" fill="none" />
          <path d="M-20,230 C140,180 260,270 420,230 C560,195 680,270 820,230" stroke="#2DD4BF" strokeWidth="1" fill="none" opacity="0.8" />
          <path d="M-20,330 C130,290 280,360 420,320 C560,280 700,350 820,320" stroke="#2DD4BF" strokeWidth="1" fill="none" opacity="0.6" />
          <path d="M-20,430 C150,400 260,460 420,430 C580,400 680,460 820,430" stroke="#2DD4BF" strokeWidth="1" fill="none" opacity="0.5" />
          <path d="M-20,540 C140,510 280,570 420,540 C560,510 690,570 820,540" stroke="#F5A623" strokeWidth="1" fill="none" opacity="0.35" />
          <path d="M-20,650 C150,620 280,680 420,650 C570,620 690,680 820,650" stroke="#F5A623" strokeWidth="1" fill="none" opacity="0.25" />
        </svg>

        <div className="relative z-10">
          <h1 className={display.className + " text-3xl font-bold tracking-tight text-[#E7EEF7]"}>
            MOHAFIZ
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-[#7C8BA3]">
            Flood response digital twin for the Nullah Leh / Korang Nullah
            corridor — Saidpur to Blue Area, Islamabad.
          </p>
        </div>

        <div className="relative z-10 font-mono text-xs text-[#4C6079]">
          <div className="mb-1 text-[#7C8BA3]">BOUNDING BOX</div>
          <div>N 33.7350° &nbsp; S 33.6700°</div>
          <div>E 73.0850° &nbsp; W 73.0100°</div>
        </div>
      </div>

      <div className="flex w-full flex-col items-center justify-center px-6 py-16 md:w-1/2">
        <div className="w-full max-w-sm">
          <div className={display.className + " mb-1 text-xl font-medium md:hidden"}>
            MOHAFIZ
          </div>

          <div className="mb-8 flex gap-1 rounded-lg border border-white/[.08] bg-white/[.02] p-1">
            <button
              type="button"
              onClick={function () { setMode("login"); setStatus("idle"); setMessage(""); }}
              className={"flex-1 rounded-md py-2 text-sm font-medium transition-colors " + (mode === "login" ? "bg-[#2DD4BF] text-[#06231F]" : "text-[#7C8BA3] hover:text-[#E7EEF7]")}
            >
              Log in
            </button>
            <button
              type="button"
              onClick={function () { setMode("signup"); setStatus("idle"); setMessage(""); }}
              className={"flex-1 rounded-md py-2 text-sm font-medium transition-colors " + (mode === "signup" ? "bg-[#2DD4BF] text-[#06231F]" : "text-[#7C8BA3] hover:text-[#E7EEF7]")}
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-[#7C8BA3]">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={function (e) { setEmail(e.target.value); }}
                className="w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3.5 py-2.5 text-sm text-[#E7EEF7] outline-none placeholder:text-[#4C6079] focus:border-[#2DD4BF]/50 focus:ring-2 focus:ring-[#2DD4BF]/20"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-[#7C8BA3]">
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
                className="w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3.5 py-2.5 text-sm text-[#E7EEF7] outline-none placeholder:text-[#4C6079] focus:border-[#2DD4BF]/50 focus:ring-2 focus:ring-[#2DD4BF]/20"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg bg-[#2DD4BF] py-2.5 text-sm font-semibold text-[#06231F] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {status === "loading" ? "Working..." : mode === "login" ? "Log in" : "Create account"}
            </button>
          </form>

          {message && (
            <div
              className={"mt-4 rounded-lg border px-3.5 py-2.5 text-sm " + (status === "error" ? "border-[#FB7185]/30 bg-[#FB7185]/10 text-[#FB7185]" : "border-[#2DD4BF]/30 bg-[#2DD4BF]/10 text-[#2DD4BF]")}
            >
              {message}
            </div>
          )}

          {token && (
            <div className="mt-3 rounded-lg border border-white/[.08] bg-white/[.02] px-3.5 py-2.5 font-mono text-xs text-[#7C8BA3]">
              token: {token.slice(0, 24)}...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
