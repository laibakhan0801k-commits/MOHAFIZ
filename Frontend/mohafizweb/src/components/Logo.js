// Mohafiz's mark: a shield (the name means "protector" in Urdu) with a
// water-line cut through it — flood protection, in one glyph. Pure
// inline SVG, no image asset, so it's crisp at any size and themes with
// the same flow/ink tokens as everything else.
export function LogoMark({ className = "w-8 h-8" }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Mohafiz shield">
      <path
        d="M16 2.5 L27 6.5 V15 C27 22.5 22.2 27.6 16 29.5 C9.8 27.6 5 22.5 5 15 V6.5 Z"
        className="fill-flow"
      />
      <path
        d="M16 2.5 L27 6.5 V15 C27 22.5 22.2 27.6 16 29.5 C9.8 27.6 5 22.5 5 15 V6.5 Z"
        fill="none"
        className="stroke-ink"
        strokeWidth="1"
        opacity="0.15"
      />
      <path
        d="M8 15.5 C10.5 13.5 12.5 17 15 15 C17.5 13 19.5 16.5 22 14.5"
        fill="none"
        className="stroke-ink"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M8 20 C10.5 18 12.5 21.5 15 19.5 C17.5 17.5 19.5 21 22 19"
        fill="none"
        className="stroke-ink"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export default function Logo({ markClassName = "w-8 h-8", textClassName = "font-display text-lg font-medium text-paper" }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark className={markClassName} />
      <span className={textClassName}>Mohafiz</span>
    </span>
  );
}
