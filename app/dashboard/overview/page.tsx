'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { OverviewResponse } from '@/lib/types';

type RangeFilter = '7' | '30' | '90';

function formatShort(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeFilter>('7');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/overview?days=${range}`, { cache: 'no-store' });
    if (res.ok) {
      setData((await res.json()) as OverviewResponse);
    }
    setLoading(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const ranges: Array<{ key: RangeFilter; label: string }> = [
    { key: '7', label: 'Últimos 7 días' },
    { key: '30', label: '30 días' },
    { key: '90', label: '90 días' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <h2 className="text-base font-semibold text-gray-100">Resumen semanal</h2>
        <div className="flex items-center gap-2">
          {ranges.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                range === r.key
                  ? 'bg-whatsapp-500/15 text-whatsapp-600'
                  : 'bg-surface-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading || !data ? (
          <div className="text-center text-gray-500 text-sm py-8">Cargando…</div>
        ) : (
          <>
            {/* Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              <MetricCard label="Nuevas conversaciones" value={data.metrics.conversations_new} />
              <MetricCard label="Mensajes de clientes" value={data.metrics.messages_customer} />
              <MetricCard label="Mensajes de Sol" value={data.metrics.messages_sol} />
              <MetricCard label="Conversaciones activas (5+)" value={data.metrics.deep_conversations} hint="Clientes engaged" />
              <MetricCard label="Escaladas" value={data.metrics.escalated} hint="Requirieron operador" />
              <MetricCard label="Ventas cerradas" value={data.metrics.conversions} hint="/won o botón verde" />
            </div>

            {/* Top questions */}
            <section className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-200">
                  Preguntas repetidas
                </h3>
                <Link href="/dashboard/questions" className="text-xs text-whatsapp-600 hover:text-whatsapp-500">
                  Ver todas →
                </Link>
              </div>
              {data.top_questions.length === 0 ? (
                <p className="text-sm text-gray-500">
                  Ninguna pregunta repetida este período. Necesitas más datos o ajustar el rango.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.top_questions.map((q, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 pb-2 border-b border-surface-700 last:border-0">
                      <p className="text-sm text-gray-300 flex-1 min-w-0">{q.sample}</p>
                      <div className="flex items-center gap-2 shrink-0 text-xs">
                        <span className="px-2 py-0.5 rounded-full bg-whatsapp-500/15 text-whatsapp-600">
                          {q.distinct_phones} cliente{q.distinct_phones !== 1 ? 's' : ''}
                        </span>
                        <span className="text-gray-500">{q.count}×</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-gray-500 pt-2">
                💡 Si una pregunta aparece de 2+ clientes distintos, conviene agregarla como entrada de base de conocimiento en{' '}
                <Link href="/dashboard/knowledge" className="text-whatsapp-600 hover:text-whatsapp-500">Conocimiento</Link>.
              </p>
            </section>

            {/* Lost customers preview */}
            <section className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-200">
                  Clientes perdidos (24h+ sin respuesta)
                </h3>
                <Link href="/dashboard/lost" className="text-xs text-whatsapp-600 hover:text-whatsapp-500">
                  Ver todos →
                </Link>
              </div>
              {data.lost_customers.length === 0 ? (
                <p className="text-sm text-gray-500">Ningún cliente perdido. 🎉</p>
              ) : (
                <ul className="space-y-2">
                  {data.lost_customers.slice(0, 5).map((l) => (
                    <li key={l.conversation_id} className="flex items-start justify-between gap-3 pb-2 border-b border-surface-700 last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-300">
                          {l.customer_name ?? l.phone_number}
                        </p>
                        <p className="text-xs text-gray-500 italic truncate">
                          &ldquo;{l.last_message_snippet}&rdquo;
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-xs">
                        <span className="px-2 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400">
                          {l.hours_silent}h
                        </span>
                        <span className="text-gray-500">{formatShort(l.last_message_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-100 mt-1">{value}</p>
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}
