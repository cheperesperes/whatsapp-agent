import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Oiikon Sol — WhatsApp Agent',
  description: 'Panel de control del agente Sol para Oiikon',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
