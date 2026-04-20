import type { Config } from 'tailwindcss';

// LIGHT THEME — WhatsApp-inspired.
//
// We deliberately INVERT both `gray` and `surface` so that class names already
// scattered across the codebase (text-gray-100, bg-surface-800, etc.) keep
// working but render as a light WhatsApp-style UI instead of a dark dashboard.
// `gray-100` → near-black text; `surface-800` → white panel; `surface-900`
// → page wallpaper (#EFEAE2 — WhatsApp's "doodle" cream tone).
//
// All other Tailwind default colors (orange, purple, blue, etc.) are
// untouched and continue to work normally.
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Oiikon brand palette (amber — used for warm accents)
        brand: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        // Surface tokens (semantic, light theme).
        // 900 = outermost wallpaper · 800 = panel · 700 = input/hover ·
        // 600 = divider · 500 = stronger border.
        // We pulled `800` off pure white so the dashboard panels (sidebar,
        // conversation list, info column) read as soft gray — closer to the
        // real WhatsApp Web look. Incoming chat bubbles use `bg-white`
        // explicitly so they still pop against the cream wallpaper.
        surface: {
          900: '#EFEAE2', // WhatsApp chat wallpaper tint
          800: '#F0F2F5', // panel background (soft gray, was #FFFFFF)
          700: '#E4E7EB', // input bg / hover (slightly darker)
          600: '#D8DCE0', // divider
          500: '#C4CACE', // stronger border
        },
        // WhatsApp accent (used for primary actions + outgoing bubble)
        whatsapp: {
          50: '#E7F8E5',
          100: '#DCF8C6', // outgoing bubble (sender = us)
          400: '#25D366', // logo green / online dot
          500: '#128C7E', // primary teal
          600: '#075E54', // dark teal
        },
        // INVERTED gray scale — text-gray-100 reads as near-black,
        // text-gray-500 stays mid-grey (works as muted text either way).
        gray: {
          50: '#111B21', // darkest text (was lightest)
          100: '#1F2937', // primary text on light bg
          200: '#374151',
          300: '#3B4A54', // labels
          400: '#54656F', // secondary text (WhatsApp muted)
          500: '#667781', // placeholder / muted
          600: '#8696A0',
          700: '#AEBAC1',
          800: '#D1D7DB',
          900: '#F0F2F5', // lightest (was darkest)
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
