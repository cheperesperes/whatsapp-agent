'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/learning — Sol's interaction-learning loop.
// Shows the daily AI reviews (Amazon-top-seller rubric), the distilled
// coaching directives currently injected into Sol's prompt, and lets the
// operator run an evaluation now, add manual coaching, or retire a directive.

// Mirror of REVIEW_DIMENSION_LABELS in lib/learning.ts. Kept local because
// that module is server-only (Anthropic + service-role Supabase clients).
const DIMENSIONS: Array<{ id: string; label: string }> = [
  { id: 'calidez_humana', label: 'Calidez humana' },
  { id: 'obsesion_cliente', label: 'Obsesión por el cliente' },
  { id: 'confianza', label: 'Confianza' },
  { id: 'proactividad', label: 'Proactividad' },
  { id: 'cierre_natural', label: 'Cierre natural' },
  { id: 'idioma_tono', label: 'Idioma y tono' },
];

const CATEGORIES = [
  'apertura',
  'descubrimiento',
  'recomendacion',
  'objeciones',
  'cierre',
  'tono',
  'general',
];

interface Review {
  id: string;
  conversation_id: string;
  review_date: string;
  overall_score: number;
  scores: Record<string, number> | null;
  customer_sentiment: string | null;
  what_worked: string | null;
  what_failed: string | null;
  missed_opportunity: string | null;
  message_count: number;
  language: string | null;
  channel: string | null;
  created_at: string;
  conversations: { phone_number: string | null; customer_name: string | null } | null;
}

interface Learning {
  id: string;
  directive: string;
  category: string;
  rationale: string | null;
  status: 'active' | 'retired';
  source: 'auto' | 'manual';
  times_reinforced: number;
  updated_at: string;
}

interface Overview {
  stats: {
    reviewed_7d: number;
    avg_score_7d: number | null;
    dimension_averages: Record<string, number | null>;
    sentiment_counts: Record<string, number>;
    last_run: string | null;
  };
  reviews: Review[];
  learnings: Learning[];
}

function scoreColor(score: number): string {
  if (score >= 8) return 'bg-green-500/15 text-green-400 border-green-500/30';
  if (score >= 6) return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30';
  return 'bg-red-500/15 text-red-400 border-red-500/30';
}

const SENTIMENT_EMOJI: Record<string, string> = {
  contento: '😊',
  neutral: '😐',
  frustrado: '😟',
};

export default function LearningPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [newDirective, setNewDirective] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [showRetired, setShowRetired] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/learning/overview', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) {
        setSetupNeeded(!!json.setup_needed);
        setError(json.hint ?? json.error ?? 'Error cargando datos');
        setData(null);
      } else {
        setData(json);
        setSetupNeeded(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch('/api/cron/sol-learning?limit=20', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setRunResult(`Error: ${json.error ?? res.status}`);
      } else {
        setRunResult(
          `Evaluadas: ${json.reviewed} · ya evaluadas hoy: ${json.skipped_already_reviewed} · promedio ${json.avg_score ?? '—'}/10 · aprendizajes nuevos considerados: ${json.new_candidate_learnings}`
        );
        await load();
      }
    } catch (e) {
      setRunResult(`Error: ${e instanceof Error ? e.message : 'red'}`);
    }
    setRunning(false);
  }

  async function addManual() {
    const directive = newDirective.trim();
    if (directive.length < 10) return;
    const res = await fetch('/api/learning/learnings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directive, category: newCategory }),
    });
    const json = await res.json();
    if (!res.ok) {
      setRunResult(`No se pudo agregar: ${json.error ?? res.status}`);
      return;
    }
    setNewDirective('');
    await load();
  }

  async function toggleLearning(l: Learning) {
    await fetch('/api/learning/learnings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: l.id, status: l.status === 'active' ? 'retired' : 'active' }),
    });
    await load();
  }

  const active = (data?.learnings ?? []).filter((l) => l.status === 'active');
  const retired = (data?.learnings ?? []).filter((l) => l.status === 'retired');
  const sc = data?.stats.sentiment_counts ?? {};
  const sentimentTotal = (sc.contento ?? 0) + (sc.neutral ?? 0) + (sc.frustrado ?? 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">Aprendizaje de Sol</h1>
            <p className="text-sm text-gray-500">
              Evaluación diaria de conversaciones con mentalidad de top seller de Amazon — Sol
              aprende y adapta su trato humano.
            </p>
          </div>
          <button
            type="button"
            onClick={runNow}
            disabled={running}
            className="px-4 py-2 rounded-lg bg-whatsapp-500/15 text-whatsapp-600 border border-whatsapp-500/30
                       text-sm font-medium hover:bg-whatsapp-500/25 transition-colors disabled:opacity-50"
          >
            {running ? 'Evaluando…' : 'Evaluar ahora'}
          </button>
        </div>

        {runResult && (
          <div className="text-sm text-gray-300 bg-surface-800 border border-surface-600 rounded-lg px-4 py-3">
            {runResult}
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-4 py-3 text-sm">
            {setupNeeded ? (
              <>
                <p className="font-medium">Falta crear las tablas de aprendizaje.</p>
                <p className="mt-1 text-red-300/80">
                  Aplica la migración{' '}
                  <code className="text-xs">supabase/migrations/20260610_sol_interaction_learning.sql</code>{' '}
                  en Supabase y recarga.
                </p>
              </>
            ) : (
              error
            )}
          </div>
        )}

        {loading && !data && <p className="text-sm text-gray-500">Cargando…</p>}

        {data && (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Nota promedio (7d)</p>
                <p className="text-2xl font-semibold text-white mt-1">
                  {data.stats.avg_score_7d ?? '—'}
                  <span className="text-sm text-gray-500">/10</span>
                </p>
              </div>
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Evaluadas (7d)</p>
                <p className="text-2xl font-semibold text-white mt-1">{data.stats.reviewed_7d}</p>
              </div>
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Clientes contentos (7d)</p>
                <p className="text-2xl font-semibold text-white mt-1">
                  {sentimentTotal ? Math.round(((sc.contento ?? 0) / sentimentTotal) * 100) : '—'}
                  <span className="text-sm text-gray-500">%</span>
                </p>
              </div>
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Coaching activo</p>
                <p className="text-2xl font-semibold text-white mt-1">{active.length}</p>
              </div>
            </div>

            {/* Dimension bars */}
            <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-white mb-3">
                Dimensiones (promedio 7 días, escala 1–5)
              </h2>
              <div className="space-y-2">
                {DIMENSIONS.map((d) => {
                  const v = data.stats.dimension_averages[d.id];
                  const pct = v ? (v / 5) * 100 : 0;
                  return (
                    <div key={d.id} className="flex items-center gap-3">
                      <span className="w-44 shrink-0 text-xs text-gray-400">{d.label}</span>
                      <div className="flex-1 h-2 rounded-full bg-surface-700 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-8 text-right text-xs text-gray-300">{v ?? '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Active learnings */}
            <div className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  Coaching inyectado en el prompt de Sol
                </h2>
                {retired.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowRetired((s) => !s)}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    {showRetired ? 'Ocultar retirados' : `Retirados (${retired.length})`}
                  </button>
                )}
              </div>

              {active.length === 0 && (
                <p className="text-sm text-gray-500">
                  Aún no hay aprendizajes — corre una evaluación o agrega coaching manual.
                </p>
              )}

              {active.map((l) => (
                <div
                  key={l.id}
                  className="flex items-start gap-3 bg-surface-700/50 border border-surface-600 rounded-lg px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200">{l.directive}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                      <span className="px-1.5 py-0.5 rounded bg-surface-600 text-gray-400">
                        {l.category}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          l.source === 'manual'
                            ? 'bg-brand-500/15 text-brand-500'
                            : 'bg-surface-600 text-gray-400'
                        }`}
                      >
                        {l.source === 'manual' ? 'Manual (Ed)' : 'Auto'}
                      </span>
                      {l.source === 'auto' && <span>reforzado ×{l.times_reinforced}</span>}
                      {l.rationale && <span className="truncate">· {l.rationale}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleLearning(l)}
                    className="shrink-0 text-xs text-gray-500 hover:text-red-400 transition-colors"
                    title="Retirar del prompt"
                  >
                    Retirar
                  </button>
                </div>
              ))}

              {showRetired &&
                retired.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-start gap-3 border border-surface-700 rounded-lg px-3 py-2.5 opacity-60"
                  >
                    <p className="flex-1 text-sm text-gray-400 line-through">{l.directive}</p>
                    <button
                      type="button"
                      onClick={() => toggleLearning(l)}
                      className="shrink-0 text-xs text-gray-500 hover:text-green-400"
                    >
                      Reactivar
                    </button>
                  </div>
                ))}

              {/* Manual add */}
              <div className="pt-2 border-t border-surface-600 flex flex-col md:flex-row gap-2">
                <input
                  value={newDirective}
                  onChange={(e) => setNewDirective(e.target.value)}
                  placeholder="Agregar coaching manual (ej.: Usa el nombre del cliente en el primer saludo)"
                  className="flex-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-gray-200
                             placeholder:text-gray-600 focus:outline-none focus:border-whatsapp-500/50"
                  maxLength={220}
                />
                <div className="flex gap-2">
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="bg-surface-700 border border-surface-600 rounded-lg px-2 py-2 text-sm text-gray-300"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addManual}
                    disabled={newDirective.trim().length < 10}
                    className="px-3 py-2 rounded-lg bg-whatsapp-500/15 text-whatsapp-600 border border-whatsapp-500/30
                               text-sm font-medium hover:bg-whatsapp-500/25 disabled:opacity-40"
                  >
                    Agregar
                  </button>
                </div>
              </div>
            </div>

            {/* Recent reviews */}
            <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-white mb-3">Últimas evaluaciones</h2>
              {data.reviews.length === 0 && (
                <p className="text-sm text-gray-500">Sin evaluaciones todavía.</p>
              )}
              <div className="space-y-2">
                {data.reviews.map((r) => {
                  const who =
                    r.conversations?.customer_name ||
                    r.conversations?.phone_number ||
                    r.conversation_id.slice(0, 8);
                  const isOpen = expanded === r.id;
                  return (
                    <div
                      key={r.id}
                      className="border border-surface-600 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-surface-700/40 transition-colors"
                      onClick={() => setExpanded(isOpen ? null : r.id)}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`shrink-0 w-12 text-center text-sm font-semibold px-1.5 py-0.5 rounded border ${scoreColor(r.overall_score)}`}
                        >
                          {r.overall_score}/10
                        </span>
                        <span className="shrink-0">
                          {SENTIMENT_EMOJI[r.customer_sentiment ?? 'neutral'] ?? '😐'}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-sm text-gray-300">{who}</span>
                        <span className="shrink-0 text-[11px] text-gray-600">
                          {r.channel ?? 'whatsapp'} · {r.review_date}
                        </span>
                      </div>
                      {(r.what_failed || r.what_worked) && (
                        <p className="mt-1.5 text-xs text-gray-500 truncate">
                          {r.what_failed ? `⚠ ${r.what_failed}` : `✓ ${r.what_worked}`}
                        </p>
                      )}
                      {isOpen && (
                        <div className="mt-2 pt-2 border-t border-surface-600 space-y-1.5 text-xs">
                          {r.what_worked && (
                            <p className="text-green-400/90">✓ {r.what_worked}</p>
                          )}
                          {r.what_failed && <p className="text-red-400/90">⚠ {r.what_failed}</p>}
                          {r.missed_opportunity && (
                            <p className="text-yellow-400/90">◎ Oportunidad: {r.missed_opportunity}</p>
                          )}
                          {r.scores && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500 pt-1">
                              {DIMENSIONS.map((d) => (
                                <span key={d.id}>
                                  {d.label}: <span className="text-gray-300">{r.scores?.[d.id] ?? '—'}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
