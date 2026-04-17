'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';
import type { LostCustomer } from '@/lib/types';

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

type SilentFilter = '24' | '48' | '168';

export default function LostCustomersPage() {
  const [lost, setLost] = useState<LostCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [silent, setSilent] = useState<SilentFilter>('24');
  const [minMsgs, setMinMsgs] = useState(3);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({
      silentHours: silent,
      minUserMessages: String(minMsgs),
      limit: '200',
    });
    const res = await fetch(`/api/lost-customers?${qs}`, { cache: 'no-store' });
    if (res.ok) {
      const { lost: data } = (await res.json()) as { lost: LostCustomer[] };
      setLost(data ?? []);
    }
    setLoading(false);
  }, [silent, minMsgs]);

  useEffect(() => { load(); }, [load]);

  const silentOpts: Array<{ key: SilentFilter; label: string }> = [
    { key: '24', label: '24h+' },
    { key: '48', label: '2 días+' },
    { key: '168', label: '7 días+' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-white">Clientes perdidos</h2>
          <span className="text-xs text-gray-400">{lost.length} necesitan seguimiento</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <span className="text-xs text-gray-500">Silencio:</span>
        {silentOpts.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSilent(s.key)}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
              silent === s.key
                ? 'bg-brand-500/20 text-brand-400'
                : 'bg-surface-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
        <span className="text-xs text-gray-500 ml-2">Mín. mensajes:</span>
        <input
          type="number"
          min={1}
          max={20}
          value={minMsgs}
          onChange={(e) => setMinMsgs(Math.max(1, parseInt(e.target.value, 10) || 1))}
          className="text-xs w-16 px-2 py-1 rounded bg-surface-700 text-gray-200 border border-surface-600"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-center text-gray-500 text-sm py-8">Cargando…</div>
        ) : lost.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            Ningún cliente perdido con este filtro. 🎉
          </div>
        ) : (
          lost.map((l) => (
            <div key={l.conversation_id} className="card p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-gray-200">
                    {l.customer_name ?? l.phone_number}
                  </span>
                  {l.customer_name && (
                    <span className="text-xs text-gray-600">{l.phone_number}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-400">
                    {l.user_message_count} mensajes
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400">
                    {l.hours_silent}h silencio
                  </span>
                  <span className={`px-2 py-0.5 rounded-full ${
                    l.last_message_role === 'user'
                      ? 'bg-red-900/40 text-red-400'
                      : 'bg-surface-700 text-gray-400'
                  }`}>
                    último: {l.last_message_role === 'user' ? 'cliente' : 'Sol'}
                  </span>
                  {l.escalated && (
                    <span className="px-2 py-0.5 rounded-full bg-orange-900/40 text-orange-400">
                      escalado
                    </span>
                  )}
                </div>
              </div>
              <p className="text-sm text-gray-400 italic">
                &ldquo;{l.last_message_snippet}&rdquo;
              </p>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{formatFull(l.last_message_at)}</span>
                <a
                  href={`https://wa.me/${l.phone_number.replace(/^\+/, '')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-brand-400 hover:text-brand-300"
                >
                  Contactar por WhatsApp →
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
