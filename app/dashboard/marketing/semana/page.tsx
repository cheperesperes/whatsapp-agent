'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

// /dashboard/marketing/semana — the weekly plan. Sol prepares the week's posts on
// Sunday; here the owner reads them once, approves (or rejects) and is done.
// Approved posts are published by Sol on their date. Nothing publishes from here.

interface Post {
  id: string;
  date: string;
  language: string;
  status: string;
  daily_theme: string | null;
  product_sku: string | null;
  error_message: string | null;
  facebook_post: string | null;
  image_url: string | null;
  image_status: string | null;
  has_video: boolean;
  on_facebook: boolean;
  on_instagram: boolean;
  product_name: string | null;
  product_in_stock: boolean | null;
  product_price: number | null;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending_approval: { label: 'Por aprobar', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  approved: { label: 'Aprobada · programada', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  publishing: { label: 'Publicando…', cls: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
  published: { label: 'Publicada', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  partial: { label: 'Publicada en parte', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  failed: { label: 'Error', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
};

function dayLabel(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function WeeklyPlanPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/marketing/week', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Error');
      else { setPosts(json.posts ?? []); setToday(json.today ?? ''); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (ids: string[], action: 'approve' | 'reject' | 'unapprove') => {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/marketing/week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Error');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const upcoming = useMemo(() => posts.filter((p) => p.status === 'pending_approval' || p.status === 'approved'), [posts]);
  const done = useMemo(() => posts.filter((p) => !(p.status === 'pending_approval' || p.status === 'approved')).reverse(), [posts]);
  // Approvable in one tap: waiting, product still sellable.
  const approvable = upcoming.filter((p) => p.status === 'pending_approval' && p.product_in_stock !== false);
  const approvedCount = upcoming.filter((p) => p.status === 'approved').length;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 text-gray-200">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h1 className="text-xl font-semibold">Plan de la semana</h1>
        <Link href="/dashboard/marketing" className="text-sm text-gray-400 hover:text-gray-200 underline">
          Editar o crear publicaciones
        </Link>
      </div>
      <p className="text-sm text-gray-400 mb-5">
        Sol prepara las publicaciones el domingo. Apruébalas aquí y Sol las publica sola en su fecha (10 AM, hora del Este).
        Nada se publica sin tu aprobación.
      </p>

      {error && <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/60 px-4 py-3">
        <div className="text-sm">
          <span className="font-semibold">{approvable.length}</span> por aprobar ·{' '}
          <span className="font-semibold">{approvedCount}</span> programadas
        </div>
        <button
          disabled={busy || approvable.length === 0}
          onClick={() => act(approvable.map((p) => p.id), 'approve')}
          className="ml-auto min-h-[44px] rounded-lg bg-orange-600 px-4 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-40"
        >
          Aprobar todas ({approvable.length})
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">Cargando…</p>}
      {!loading && upcoming.length === 0 && (
        <p className="rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-6 text-sm text-gray-400">
          No hay publicaciones esperando. Sol prepara la próxima semana el domingo.
        </p>
      )}

      <div className="space-y-4">
        {upcoming.map((p) => {
          const st = STATUS[p.status] ?? { label: p.status, cls: 'bg-gray-500/15 text-gray-300 border-gray-500/30' };
          const text = p.facebook_post ?? '';
          const long = text.length > 420;
          const shown = open[p.id] || !long ? text : `${text.slice(0, 420)}…`;
          const past = today && p.date < today;
          return (
            <div key={p.id} className="rounded-xl border border-gray-700 bg-gray-800/60 p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-sm font-semibold capitalize">{dayLabel(p.date)}</span>
                <span className="rounded border border-gray-600 px-1.5 py-0.5 text-xs uppercase text-gray-300">{p.language}</span>
                <span className={`rounded border px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                {past && p.status === 'pending_approval' && <span className="text-xs text-gray-400">(fecha pasada: si la apruebas sale mañana a las 10 AM)</span>}
              </div>
              <div className="mb-3 text-xs text-gray-400">
                {p.product_name ?? p.product_sku ?? 'Sin producto'}
                {p.product_price != null && <> · ${Number(p.product_price).toLocaleString('en-US')}</>}
                {p.product_in_stock === false && <span className="ml-2 font-semibold text-red-300">Agotado: no se publicará</span>}
                {p.product_in_stock === true && <span className="ml-2 text-emerald-300">En existencia</span>}
              </div>
              {p.daily_theme && <div className="mb-2 text-sm font-medium text-gray-100">{p.daily_theme}</div>}
              <div className="flex flex-col gap-3 sm:flex-row">
                {p.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" className="h-40 w-40 flex-none rounded-lg border border-gray-700 object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm text-gray-300">{shown || 'Sin texto.'}</p>
                  {long && (
                    <button onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))} className="mt-1 text-xs text-orange-400 underline">
                      {open[p.id] ? 'Ver menos' : 'Ver todo'}
                    </button>
                  )}
                  {!p.image_url && p.image_status === 'processing' && <p className="mt-2 text-xs text-gray-500">La imagen se está generando.</p>}
                </div>
              </div>
              {p.error_message && <p className="mt-2 text-xs text-amber-300/90">{p.error_message}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === 'pending_approval' ? (
                  <button disabled={busy || p.product_in_stock === false} onClick={() => act([p.id], 'approve')}
                    className="min-h-[44px] rounded-lg bg-orange-600 px-4 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-40">
                    Aprobar
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => act([p.id], 'unapprove')}
                    className="min-h-[44px] rounded-lg border border-gray-600 px-4 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40">
                    Quitar aprobación
                  </button>
                )}
                <button disabled={busy} onClick={() => act([p.id], 'reject')}
                  className="min-h-[44px] rounded-lg border border-gray-600 px-4 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40">
                  Rechazar
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {done.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-gray-300">Últimos 7 días</h2>
          <ul className="divide-y divide-gray-700 rounded-xl border border-gray-700 bg-gray-800/40">
            {done.map((p) => {
              const st = STATUS[p.status] ?? { label: p.status, cls: 'bg-gray-500/15 text-gray-300 border-gray-500/30' };
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="capitalize text-gray-300">{dayLabel(p.date)}</span>
                  <span className="text-xs uppercase text-gray-500">{p.language}</span>
                  <span className={`rounded border px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                  <span className="text-xs text-gray-500">
                    {p.on_facebook ? 'Facebook ✓' : 'Facebook —'} · {p.on_instagram ? 'Instagram ✓' : 'Instagram —'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-400">{p.daily_theme}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
