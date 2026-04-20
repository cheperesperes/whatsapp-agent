import type { Config } from 'tailwindcss';

// DARK THEME — high-contrast operator dashboard.
//
// We tried a light WhatsApp palette (PR #18) but the surfaces (cream
// #EFEAE2 + near-white #F0F2F5) were too close to each other AND most
// text classes (text-gray-400/500) were originally dark-mode tokens —
// so everything washed out. Restored a proper dark palette here so the
// existing class names (bg-surface-800, text-gray-400, etc.) read with
// the contrast they were written for.
//
// Brand stays Oiikon amber, WhatsApp green stays for chat bubbles.
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Oiikon brand (amber — used for active nav, primary accents)
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
        // Surface tokens — dark gradient.
        // 900 = page background · 800 = panels · 700 = inputs / hover ·
        // 600 = dividers · 500 = stronger borders.
        // Spaced so adjacent layers (panel on bg, input on panel) have
        // visible contrast — the previous palette had every layer within
        // 6% lightness of the next, which is why the UI looked flat.
        surface: {
          900: '#0B141A', // page background (deep slate, near WhatsApp dark)
          800: '#111B21', // panels (sidebar, list, info column)
          700: '#1F2C33', // input bg / hover
          600: '#2A3942', // dividers
          500: '#3B4A54', // stronger borders
        },
        // WhatsApp accent (primary actions + outgoing bubble)
        whatsapp: {
          50: '#E7F8E5',
          100: '#005C4B', // outgoing bubble (dark green for dark theme)
          400: '#25D366', // logo green / online dot
          500: '#128C7E', // primary teal
          600: '#075E54', // dark teal
        },
        // Standard gray scale (NOT inverted) — text-gray-100 is light,
        // text-gray-400/500 are mid-grey muted text on dark surfaces.
        gray: {
          50: '#F9FAFB',
          100: '#F3F4F6', // primary text on dark bg
          200: '#E5E7EB',
          300: '#D1D5DB', // labels / strong secondary
          400: '#9CA3AF', // secondary text
          500: '#6B7280', // muted / placeholder
          600: '#4B5563',
          700: '#374151',
          800: '#1F2937',
          900: '#111827',
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
