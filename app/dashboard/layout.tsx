'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase';

// All sidebar destinations. The mobile bottom-bar surfaces only the
// PRIMARY items (priority 1-4) plus a "Más" tile that opens a sheet
// listing the rest. Priority is by Eduardo's actual workflow: he lives
// in Conversaciones and Marketing, and visits the others ~once/day or
// less.
type NavItem = {
  href: string;
  label: string;
  // Short label used in the bottom tab bar where horizontal space is
  // ~70px per tab. `null` means "use `label`".
  shortLabel?: string;
  primary: boolean;
  icon: React.ReactNode;
};

const navItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Conversaciones',
    shortLabel: 'Chats',
    primary: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/marketing',
    label: 'Marketing',
    primary: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/suggestions',
    label: 'Sugerencias',
    shortLabel: 'KB',
    primary: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/overview',
    label: 'Resumen',
    primary: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: '/dashboard/products',
    label: 'Productos',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
  },
  {
    href: '/dashboard/competitors',
    label: 'Competencia',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
      </svg>
    ),
  },
  {
    href: '/dashboard/knowledge',
    label: 'Conocimiento',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
  {
    href: '/dashboard/lost',
    label: 'Perdidos',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/questions',
    label: 'Preguntas',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/scorecard',
    label: 'Scorecard',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/analytics',
    label: 'Analíticas',
    primary: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

const primaryNav = navItems.filter((n) => n.primary);
const secondaryNav = navItems.filter((n) => !n.primary);

function isPathActive(pathname: string, href: string): boolean {
  // /dashboard is the conversations page — only match it exactly so visiting
  // /dashboard/marketing doesn't also light up Conversaciones. All other
  // hrefs match by prefix to allow deep links.
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createBrowserClient();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the "Más" sheet when the route changes — otherwise tapping a
  // secondary item leaves the sheet hovering on the next page.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <div className="flex h-screen bg-surface-900 overflow-hidden">
      {/* Desktop sidebar — hidden on phones, visible md+ */}
      <aside className="hidden md:flex w-56 flex-col bg-surface-800 border-r border-surface-600 shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-surface-600">
          <div className="flex-shrink-0 w-8 h-8 bg-brand-500 rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 3v1m0 16v1m8.66-9h-1M4.34 12h-1m14.14-6.36-.7.7M6.22 17.66l-.7.7m0-12.72.7.7M17.78 17.66l.7.7M12 8a4 4 0 100 8 4 4 0 000-8z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-white leading-tight">Oiikon Sol</p>
            <p className="text-xs text-gray-500">WhatsApp Agent</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const active = isPathActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active
                    ? 'bg-whatsapp-500/15 text-whatsapp-600'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'
                  }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="p-2 border-t border-surface-600">
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:bg-surface-700 transition-colors"
          >
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Cerrar sesión</span>
          </button>
        </div>
      </aside>

      {/* Main content. On mobile we add bottom padding equal to the
          tab bar height + iPhone home-indicator inset so nothing hides
          under the fixed bar. */}
      <main
        className="flex-1 overflow-hidden flex flex-col min-w-0
                   pb-[calc(var(--mobile-tab-bar-height)+var(--safe-area-bottom))]
                   md:pb-0"
      >
        {children}
      </main>

      {/* Mobile bottom tab bar — fixed, primary nav + Más opener.
          Hidden on md+. Reserved height matches --mobile-tab-bar-height
          plus the iPhone home-indicator safe-area inset. */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface-800 border-t border-surface-600
                   flex items-stretch
                   pb-[var(--safe-area-bottom)]"
        aria-label="Navegación principal"
      >
        {primaryNav.map((item) => {
          const active = isPathActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px]
                          text-[11px] font-medium transition-colors
                          ${active ? 'text-whatsapp-600' : 'text-gray-500 hover:text-gray-300'}`}
              aria-current={active ? 'page' : undefined}
            >
              {item.icon}
              <span className="truncate max-w-full px-1">
                {item.shortLabel ?? item.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px]
                      text-[11px] font-medium transition-colors
                      ${moreOpen ? 'text-whatsapp-600' : 'text-gray-500 hover:text-gray-300'}`}
          aria-label="Más opciones"
          aria-expanded={moreOpen}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <circle cx="5" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="19" cy="12" r="1.5" fill="currentColor" />
          </svg>
          <span>Más</span>
        </button>
      </nav>

      {/* Mobile "Más" sheet. Slides up from the bottom and lists every
          secondary nav item plus a Cerrar sesión row. Tapping an item
          fires the route change + auto-closes via the `pathname` effect. */}
      {moreOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/60 flex items-end"
          onClick={() => setMoreOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full bg-surface-800 rounded-t-2xl border-t border-surface-600
                       max-h-[80vh] overflow-y-auto
                       pb-[calc(var(--safe-area-bottom)+8px)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="w-10 h-1 rounded-full bg-surface-500" />
            </div>
            <div className="px-2 pb-2 space-y-1">
              {secondaryNav.map((item) => {
                const active = isPathActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium min-h-[48px]
                                ${active
                                  ? 'bg-whatsapp-500/15 text-whatsapp-600'
                                  : 'text-gray-300 active:bg-surface-700'
                                }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium min-h-[48px]
                           text-red-400 active:bg-surface-700"
              >
                <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                <span>Cerrar sesión</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
