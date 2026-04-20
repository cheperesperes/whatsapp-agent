'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';

type RuleId =
  | 'answered_the_ask'
  | 'recommended_with_link'
  | 'avoided_permission_asking'
  | 'avoided_irrelevant_limit'
  | 'no_hallucination'
  | 'concise_response';

interface AggregateRule {
  label: string;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
}

interface ScorecardRuleResult {
  passed: boolean;
  evidence: string;
}

interface ScorecardResult {
  conversation_id: string;
  rules: Record<RuleId, ScorecardRuleResult>;
  pass_count: number;
  rule_count: number;
  overall_summary: string;
  teachable_suggestion: { question: string; answer: string; rationale: string } | null;
}

interface EvaluateResponse {
  window_days: number;
  sampled: number;
  judged: number;
  self_teach_suggestions_created: number;
  rules: Record<RuleId, AggregateRule>;
  worst_offenders: ScorecardResult[];
  all_scorecards: ScorecardResult[];
}

function formatPct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function barColor(rate: number) {
  if (rate >= 0.9) return 'bg-green-500';
  if (rate >= 0.7) return 'bg-yellow-500';
  return 'bg-red-500';
}

export default function ScorecardPage() {
  const [days, setDays] = useState(7);
  const [sample, setSample] = useState(15);
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runEvaluation() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/evaluate?days=${days}&sample=${sample}`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${txt.slice(0, 160)}`);
      }
      const data = (await res.json()) as EvaluateResponse;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }

  const ruleOrder: RuleId[] = [
    'answered_the_ask',
    'recommended_with_link',
    'avoided_permission_asking',
    'avoided_irrelevant_limit',
    'no_hallucination',
    'concise_response',
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-gray-100">Scorecard de Sol</h2>
          <span className="text-xs text-gray-400">Auto-evaluación contra las reglas del agente</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-gray-400">
          Ventana:
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-surface-700 text-gray-200 text-xs rounded px-2 py-1 border border-surface-600"
          >
            <option value={1}>1 día</option>
            <option value={3}>3 días</option>
            <option value={7}>7 días</option>
            <option value={14}>14 días</option>
            <option value={30}>30 días</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          Muestra:
          <select
            value={sample}
            onChange={(e) => setSample(Number(e.target.value))}
            className="bg-surface-700 text-gray-200 text-xs rounded px-2 py-1 border border-surface-600"
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
        <button
          type="button"
          onClick={runEvaluation}
          disabled={loading}
          className="btn-primary text-xs"
        >
          {loading ? 'Evaluando…' : 'Ejecutar evaluación'}
        </button>
        {result && (
          <span className="text-xs text-gray-500">
            {result.judged} / {result.sampled} conversaciones juzgadas · {result.self_teach_suggestions_created} sugerencias creadas
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="card p-3 border border-red-700/50 bg-red-900/20 text-sm text-red-300">
            Error: {error}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="text-center text-gray-500 text-sm py-8">
            Haga clic en &quot;Ejecutar evaluación&quot; para que Sol revise sus últimas conversaciones contra las reglas del agente.
          </div>
        )}

        {loading && (
          <div className="text-center text-gray-500 text-sm py-8">
            Ejecutando el juez sobre una muestra de conversaciones…
          </div>
        )}

        {result && (
          <>
            {/* Rule pass-rate bars */}
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-200">Tasa de cumplimiento por regla</h3>
              {ruleOrder.map((id) => {
                const r = result.rules[id];
                if (!r) return null;
                return (
                  <div key={id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-300">{r.label}</span>
                      <span className="text-gray-400 tabular-nums">
                        {r.pass_count}/{r.pass_count + r.fail_count} · {formatPct(r.pass_rate)}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${barColor(r.pass_rate)} transition-all`}
                        style={{ width: `${Math.round(r.pass_rate * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Worst offenders */}
            {result.worst_offenders.length > 0 && (
              <div className="card p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-200">Peores casos (para revisar)</h3>
                {result.worst_offenders.map((s) => {
                  const failed = (Object.entries(s.rules) as [RuleId, ScorecardRuleResult][])
                    .filter(([, v]) => !v.passed);
                  return (
                    <div key={s.conversation_id} className="border-l-2 border-red-500/60 pl-3 space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <a
                          href={`/dashboard?conversation=${s.conversation_id}`}
                          className="text-brand-400 hover:underline font-mono"
                        >
                          {s.conversation_id.slice(0, 8)}…
                        </a>
                        <span className="text-gray-500">
                          {s.pass_count}/{s.rule_count} reglas pasadas
                        </span>
                      </div>
                      {s.overall_summary && (
                        <p className="text-xs text-gray-400">{s.overall_summary}</p>
                      )}
                      {failed.length > 0 && (
                        <ul className="text-xs text-red-300/80 space-y-0.5 mt-1">
                          {failed.map(([ruleId, r]) => (
                            <li key={ruleId}>
                              <span className="font-semibold">
                                {result.rules[ruleId]?.label ?? ruleId}:
                              </span>{' '}
                              {r.evidence}
                            </li>
                          ))}
                        </ul>
                      )}
                      {s.teachable_suggestion && (
                        <p className="text-xs text-green-400/80 italic mt-1">
                          💡 Sugerencia creada: &quot;{s.teachable_suggestion.question}&quot;
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Full table */}
            <details className="card p-4">
              <summary className="text-sm font-semibold text-gray-200 cursor-pointer">
                Todas las conversaciones evaluadas ({result.all_scorecards.length})
              </summary>
              <div className="mt-3 space-y-2">
                {result.all_scorecards.map((s) => (
                  <div key={s.conversation_id} className="flex items-center gap-3 text-xs py-1.5 border-b border-surface-700 last:border-0">
                    <a
                      href={`/dashboard?conversation=${s.conversation_id}`}
                      className="text-brand-400 hover:underline font-mono shrink-0 w-20"
                    >
                      {s.conversation_id.slice(0, 8)}
                    </a>
                    <span className="tabular-nums text-gray-400 shrink-0 w-12">
                      {s.pass_count}/{s.rule_count}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      {ruleOrder.map((id) => (
                        <span
                          key={id}
                          title={result.rules[id]?.label ?? id}
                          className={`w-2 h-2 rounded-full ${s.rules[id]?.passed ? 'bg-green-500' : 'bg-red-500'}`}
                        />
                      ))}
                    </div>
                    <span className="text-gray-500 truncate">{s.overall_summary}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
