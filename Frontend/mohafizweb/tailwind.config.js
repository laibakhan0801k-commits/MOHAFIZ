/** @type {import('tailwindcss').Config} */
const config = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Dark green + lime palette. ink is now the primary BACKGROUND
        // (darkest), paper is now the primary TEXT color (near-white) —
        // a full light-to-dark flip, not a hex swap under the same
        // roles. surface/surface-2 step up in lightness for panels and
        // their hover/elevated state; flow (lime) is the one accent
        // color for CTAs and positive/safe states; alert (orange-red)
        // is reserved for danger/hazard content only, never decorative.
        ink: "#062D29",
        surface: "#0A3D37",
        "surface-2": "#0E4A43",
        paper: "#F2F8F5",
        mint: "#DCEFE9",
        flow: "#C7FF28",
        alert: "#FF5A36",
        line: "#3E5C56",
      },
      fontFamily: {
        // Point at the CSS variables next/font/google generates in
        // src/app/layout.js, not literal font-name strings — next/font
        // self-hosts and optimizes the font files under these variable
        // names, so referencing the plain name here would silently miss
        // the loaded font and fall back to the browser default.
        display: ["var(--font-heading)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono-num)", "monospace"],
      },
    },
  },
  plugins: [],
};

module.exports = config;
