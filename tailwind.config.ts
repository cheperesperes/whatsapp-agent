import type { Config } from 'tailwindcss';

// LIGHT THEME — WhatsApp Web style.
//
// We INVERT every numeric color scale (gray, brand, red, green, yellow, blue)
// so that class names already scattered across the codebase — written for
// dark mode — keep working visually:
//   * "darker number" (300, 400) is now actually DARKER (used as text color)
//   * "lighter number" (800, 900) is now actually LIGHTER (used as bg tint)
//
// Result: `text-gray-400` reads as dark muted text, `bg-red-900/40` reads as
// faint pink badge bg, etc. — every existing component renders correctly on
// a light background without touching page code.
//
// Surface separation is deliberately strong: cream wallpaper (#EFEAE2) →
// pure white panels → soft gray inputs (#F0F2F5) → distinct dividers. PR #18
// failed because every layer was within 6% lightness of the next; here the
// jump from cream wallpaper to pure white is visible at a glance.
//
// Accent: real WhatsApp Web teal (#00A884) for primary actions / outgoing
// bubbles. Oiikon amber stays as the brand for logo + accent highlights.
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces — WhatsApp Web layered light palette.
        // 900 = page wallpaper (cream) · 800 = panel (white) ·
        // 700 = input/hover (header gray) · 600 = divider · 500 = border.
        surface: {
          900: '#EFEAE2', // WhatsApp doodle cream wallpaper
          800: '#FFFFFF', // pure white panels
          700: '#F0F2F5', // WhatsApp header gray (input bg, hover)
          600: '#E9EDEF', // divider
          500: '#D1D7DB', // stronger border
        },
        // Inverted gray — calibrated for WCAG AA contrast on white & cream.
        // Original dark-mode: text-gray-100 light, text-gray-400 muted-light.
        // Now: text-gray-100 → near-black, text-gray-400 → muted dark gray.
        gray: {
          50: '#0B141A',  // very darkest (rarely used)
          100: '#111B21', // primary text — 16.4:1 on white (AAA)
          200: '#1F2C33', // strong text
          300: '#2A3942', // labels
          400: '#3B4A54', // secondary text — 9.4:1 on white (AAA)
          500: '#54656F', // muted (WhatsApp's actual muted) — 6.3:1 (AA)
          600: '#667781', // placeholder — 4.8:1 (AA)
          700: '#8696A0', // very muted decorative
          800: '#AEBAC1', // light gray
          900: '#D1D7DB', // lightest (was darkest in dark mode)
        },
        // Inverted Oiikon brand (amber).
        // text-brand-400 → dark amber for text on white.
        // bg-brand-900 → light amber tint for badge backgrounds.
        brand: {
          50:  '#78350f', // darkest (rarely used as text)
          100: '#92400e',
          200: '#9a3412',
          300: '#b45309', // dark amber — readable on white & on bg-brand-900
          400: '#b45309', // text-brand-400 — same dark amber for clarity
          500: '#f59e0b', // brand-500 (Oiikon amber) — used for bg accents
          600: '#fbbf24',
          700: '#fcd34d',
          800: '#fde68a',
          900: '#fef3c7', // light amber tint — bg-brand-900 reads as soft pill
        },
        // WhatsApp accent — primary actions, outgoing bubbles, online dots.
        whatsapp: {
          50:  '#E7F8E5',
          100: '#D9FDD3', // outgoing bubble (real WhatsApp Web)
          200: '#B5F2A8',
          400: '#25D366', // logo green / online dot
          500: '#00A884', // primary teal (real WhatsApp Web brand)
          600: '#008069', // hover
          700: '#075E54', // dark teal
        },
        // Inverted red — bg-red-900/40 reads as faint pink, text-red-300 dark.
        red: {
          50:  '#7f1d1d',
          100: '#991b1b',
          200: '#b91c1c',
          300: '#b91c1c', // dark red text on light bg
          400: '#dc2626',
          500: '#ef4444',
          600: '#f87171',
          700: '#fca5a5',
          800: '#fecaca', // soft pink border
          900: '#fee2e2', // very light pink bg
        },
        // Inverted green
        green: {
          50:  '#14532d',
          100: '#166534',
          200: '#15803d',
          300: '#15803d', // dark green text
          400: '#16a34a',
          500: '#22c55e',
          600: '#4ade80',
          700: '#86efac',
          800: '#bbf7d0', // soft green border
          900: '#dcfce7', // very light green bg
        },
        // Inverted yellow
        yellow: {
          50:  '#713f12',
          100: '#854d0e',
          200: '#a16207',
          300: '#a16207', // dark gold text
          400: '#ca8a04',
          500: '#eab308',
          600: '#facc15',
          700: '#fde047',
          800: '#fef08a', // soft yellow border
          900: '#fef9c3', // very light yellow bg
        },
        // Inverted blue
        blue: {
          50:  '#1e3a8a',
          100: '#1e40af',
          200: '#1d4ed8',
          300: '#1d4ed8', // dark blue text
          400: '#2563eb',
          500: '#3b82f6',
          600: '#60a5fa',
          700: '#93c5fd',
          800: '#bfdbfe', // soft blue border
          900: '#dbeafe', // very light blue bg
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
