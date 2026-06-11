'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/pipeline — the sales pipeline: every quoted WhatsApp lead by
// stage, the automated nudge ladder's status, and a manual-chase queue with
// ready-to-paste copy for leads whose 24h free-form window already closed.

interface Nudge {
  kind: string;
  created_at: string;
}

interface Row {
  conversation_id: string;
  phone: string;
  name: string | null;
  sku: string | null;
  paylink_sent: boolean;
  hours_silent: number | null;
  nudges: Nudge[];
  next_auto_touch: string | null;
  suggested_es?: string;
  suggested_en?: string;
  wa_link: string;
  order_total?: number;
}

interface Overview {
  lookback_days: number;
  enabled: { sales_followup: boolean; paylink_nudge: boolean; followup_cron: boolean };
  counts: Record<string, number>;
  buckets: {
    needs_reply: Row[];
    hot: Row[];
    chase: Row[];
    browsing: Row[];
    converted: Row[];
  };
}

const KIND_LABEL: Record<string, string> = {
  quote_nudge: 'toque 1 (cotizado)',
  paylink_nudge: 'toque 1 (pay-link)',
  window_close_nudge: 'toque 2 (cierre de ventana)',
  manual_chase: 'manual',
};

function hoursLabel(h: number | null): string {
  if (h === null) return '—';
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export default function PipelinePage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/pipeline/overview', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Error');
      else setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function LeadLine({ r }: { r: Row }) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-gray-100 font-medium">{r.name ?? 'Sin nombre'}</span>
        <a href={r.wa_link} target="_blank" rel="noreferrer" className="text-emerald-300 hover:underline">
          {r.phone}
        </a>
        {r.sku && <span className="px-1.5 py-0.5 rounded bg-surface-700 text-xs text-orange-300">{r.sku}</span>}
        {r.paylink_sent && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-xs text-amber-300">💳 pay-link enviado</span>}
        <span className="text-xs text-gray-500">silencio: {hoursLabel(r.hours_silent)}</span>
        {r.nudges.length > 0 && (
          <span className="text-xs text-gray-500">
            seguimientos: {r.nudges.map((n) => KIND_LABEL[n.kind] ?? n.kind).join(' · ')}
          </span>
        )}
      </div>
    );
  }

  const b = data?.buckets;
  const allAutoOff =
    data && !data.enabled.sales_followup && !data.enabled.paylink_nudge;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Pipeline de ventas</h1>
            <p className="text-sm text-gray-500">
              Cada lead cotizado por etapa, el estado de los seguimientos automáticos y la cola de
              seguimiento manual. Últimos {data?.lookback_days ?? 14} días.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-surface-700 border border-surface-600 text-sm text-gray-300
                       hover:bg-surface-600 transition-colors disabled:opacity-50 shrink-0"
          >
            {loading ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}
        {loading && !data && <p className="text-sm text-gray-500">Cargando…</p>}

        {data && (
          <>
            {allAutoOff && (
              <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-lg px-4 py-3 text-sm">
                ⚠️ Los seguimientos automáticos están en <b>modo simulación (dry-run)</b> — no se envía
                nada. Para activarlos: <code className="text-amber-100">SALES_FOLLOWUP_ENABLED=true</code> y{' '}
                <code className="text-amber-100">PAYLINK_NUDGE_ENABLED=true</code> en Vercel.
              </div>
            )}

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                ['Por responder', data.counts.needs_reply, 'text-red-300'],
                ['Calientes (<24h)', data.counts.hot, 'text-orange-300'],
                ['Seguimiento manual', data.counts.chase, 'text-amber-300'],
                ['Sin cotizar', data.counts.browsing, 'text-gray-300'],
                ['Convertidos', data.counts.converted, 'text-emerald-300'],
              ].map(([label, n, color]) => (
                <div key={String(label)} className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                  <p className="text-xs text-gray-500">{label}</p>
                  <p className={`text-2xl font-semibold mt-1 ${color}`}>{n as number}</p>
                </div>
              ))}
            </div>

            {/* Needs reply — the customer is waiting on US. */}
            {b && b.needs_reply.length > 0 && (
              <section className="bg-surface-800 border border-red-500/40 rounded-xl p-4 space-y-3">
                <h2 className="text-sm font-semibold text-red-300">
                  🔴 Por responder — el cliente escribió y espera ({b.needs_reply.length})
                </h2>
                {b.needs_reply.map((r) => (
                  <LeadLine key={r.conversation_id} r={r} />
                ))}
              </section>
            )}

            {/* Hot — automated ladder active */}
            <section className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-orange-300">
                🔥 Calientes — ventana de 24h abierta, seguimiento automático activo ({b?.hot.length ?? 0})
              </h2>
              {(b?.hot ?? []).length === 0 && <p className="text-sm text-gray-500">Nadie en esta etapa ahora.</p>}
              {(b?.hot ?? []).map((r) => (
                <div key={r.conversation_id} className="space-y-0.5">
                  <LeadLine r={r} />
                  {r.next_auto_touch && (
                    <p className="text-xs text-gray-500 pl-0.5">próximo automático: {r.next_auto_touch}</p>
                  )}
                </div>
              ))}
            </section>

            {/* Manual chase queue */}
            <section className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-4">
              <h2 className="text-sm font-semibold text-amber-300">
                ⏰ Seguimiento manual — ventana de API cerrada; envíalo desde la app de WhatsApp ({b?.chase.length ?? 0})
              </h2>
              {(b?.chase ?? []).length === 0 && <p className="text-sm text-gray-500">Cola vacía 🎉</p>}
              {(b?.chase ?? []).map((r) => (
                <div key={r.conversation_id} className="border border-surface-600 rounded-lg p-3 space-y-2">
                  <LeadLine r={r} />
                  {r.suggested_es && (
                    <div className="text-xs text-gray-400 bg-surface-900/60 rounded p-2 whitespace-pre-wrap">
                      {r.suggested_es}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => r.suggested_es && copy(r.suggested_es, `${r.conversation_id}-es`)}
                      className="px-2 py-1 rounded bg-surface-700 border border-surface-600 text-xs text-gray-300 hover:bg-surface-600"
                    >
                      {copiedId === `${r.conversation_id}-es` ? '✓ Copiado' : 'Copiar ES'}
                    </button>
                    <button
                      type="button"
                      onClick={() => r.suggested_en && copy(r.suggested_en, `${r.conversation_id}-en`)}
                      className="px-2 py-1 rounded bg-surface-700 border border-surface-600 text-xs text-gray-300 hover:bg-surface-600"
                    >
                      {copiedId === `${r.conversation_id}-en` ? '✓ Copied' : 'Copiar EN'}
                    </button>
                    <a
                      href={r.wa_link}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-xs text-emerald-300 hover:bg-emerald-600/30"
                    >
                      Abrir en WhatsApp →
                    </a>
                  </div>
                </div>
              ))}
            </section>

            {/* Converted */}
            <section className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-emerald-300">
                💰 Convertidos ({b?.converted.length ?? 0})
              </h2>
              {(b?.converted ?? []).length === 0 && (
                <p className="text-sm text-gray-500">Sin conversiones en la ventana — el pipeline de arriba es el plan.</p>
              )}
              {(b?.converted ?? []).map((r) => (
                <div key={r.conversation_id} className="flex flex-wrap items-center gap-x-3 text-sm">
                  <LeadLine r={r} />
                  {typeof r.order_total === 'number' && (
                    <span className="text-emerald-300 font-medium">${r.order_total.toFixed(2)}</span>
                  )}
                </div>
              ))}
            </section>

            <p className="text-xs text-gray-600">
              Etapas derivadas en vivo de las conversaciones (canal WhatsApp). Excluidos: {data.counts.opted_out}{' '}
              con opt-out · {data.counts.escalated} escalados a operador. El ladder automático: toque 1 a las 2-6h
              (cotizado o pay-link) y toque 2 a las 18-23h, máx. 2 por conversación, nunca tras una respuesta,
              compra u opt-out, ni en horas de descanso del cliente.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
