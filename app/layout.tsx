import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Oiikon Sol — WhatsApp Agent',
  description: 'Panel de control del agente Sol para Oiikon',
};

// iPhone-first viewport.
//   - `viewport-fit=cover` lets the layout extend under the home-indicator
//     and notch so we can opt into safe-area insets per element. Without it
//     iOS leaves a permanent letterbox.
//   - `maximumScale=1` prevents the iOS auto-zoom that fires whenever an
//     input has font-size < 16px. We set 16px on inputs in globals.css to
//     belt-and-suspenders this, but the meta is the cheap guarantee.
//   - `userScalable=true` is kept (accessibility) — pinch-zoom still works.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: '#1f2937',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
