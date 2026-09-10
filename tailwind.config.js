
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      lineHeight: {
        "tighter": "0.5rem"
      },
      spacing: {
        // iOS home-indicator clearance. The `0px` fallback keeps the whole
        // calc() valid on browsers without env().
        "safe-b": "env(safe-area-inset-bottom, 0px)",
        // Mobile bottom nav (h-14) + its 1px top border + a little breathing
        // room + safe area — what page content has to clear so nothing is
        // trapped under, or kissing, the bar.
        "nav-safe": "calc(4rem + env(safe-area-inset-bottom, 0px))",
        // Genre sheet's scroll gutter. The sheet's panel runs to bottom:0 (so
        // its background is continuous) but the tab bar paints over its last
        // 3.5rem, so the scrollable content has to clear the bar too.
        "sheet-safe": "calc(4.75rem + env(safe-area-inset-bottom, 0px))",
      },
    },
  },
  plugins: [
    require('@tailwindcss/container-queries'),
    require('@tailwindcss/typography'),
  ],
}
