"use client";

import { useEffect, useRef, useState } from "react";

// Counts a number up from 0 once, the first time it scrolls into view —
// never repeats, and renders the final value immediately under
// prefers-reduced-motion.
export default function CountUpNumber({ end, decimals = 0, suffix = "", durationMs = 1200, className = "" }) {
  const ref = useRef(null);
  const startedRef = useRef(false);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a browser-only media query on mount, skipping the animation entirely
      setDisplay(end);
      return;
    }

    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setDisplay(end);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || startedRef.current) return;
          startedRef.current = true;
          const startTime = performance.now();

          function tick(now) {
            const progress = Math.min(1, (now - startTime) / durationMs);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplay(end * eased);
            if (progress < 1) requestAnimationFrame(tick);
            else setDisplay(end);
          }
          requestAnimationFrame(tick);
          observer.disconnect();
        });
      },
      { threshold: 0.4 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end, durationMs]);

  const formatted = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString();

  return (
    <span ref={ref} className={className}>
      {formatted}
      {suffix}
    </span>
  );
}
