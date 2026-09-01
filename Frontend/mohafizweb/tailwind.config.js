/** @type {import('tailwindcss').Config} */
const config = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#123832",
        paper: "#DCEEE6",
        flow: "#2F6F63",
        alert: "#C1602E",
        line: "#6B8D85",
        lime: "#C6F135",
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
