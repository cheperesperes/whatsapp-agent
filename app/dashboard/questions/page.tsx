'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { CustomerQuestion } from '@/lib/types';

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

type ModeFilter = 'questions' | 'all';
type RangeFilter = '7' | '30' | 'all';

export default function QuestionsPage() {
  const [questions, setQuestions] = useState<CustomerQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ModeFilter>('questions');
  const [range, setRange] = useState<RangeFilter>('30');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ mode, sinceDays: range, limit: '300' });
    const res = await fetch(`/api/questions?${qs}`, { cache: 'no-store' });
    if (res.ok) {
      const { questions: data } = (await res.json()) as { questions: CustomerQuestion[] };
      setQuestions(data ?? []);
    }
    setLoading(false);
  }, [mode, range]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return questions;
    const needle = search.trim().toLowerCase();
    return questions.filter((q) =>
      q.content.toLowerCase().includes(needle) ||
      q.phone_number.toLowerCase().includes(needle) ||
      (q.customer_name ?? '').toLowerCase().includes(needle)
    );
  }, [questions, search]);

  const modes: Array<{ key: ModeFilter; label: string }> = [
    { key: 'questions', label: 'Con "?"' },
    { key: 'all', label: 'Todos los mensajes' },
  ];

  const ranges: Array<{ key: RangeFilter; label: string }> = [
    { key: '7', label: '7 días' },
    { key: '30', label: '30 días' },
    { key: 'all', label: 'Todo' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-gray-100">Preguntas de clientes</h2>
          <span className="text-xs text-gray-400">{filtered.length} mostradas</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-2">
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                mode === m.key
                  ? 'bg-whatsapp-500/15 text-whatsapp-600'
                  : 'bg-surface-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
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
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar texto, teléfono o nombre…"
          className="flex-1 min-w-[200px] text-xs px-3 py-1.5 rounded-full bg-surface-700 text-gray-200 placeholder:text-gray-500 border border-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-center text-gray-500 text-sm py-8">Cargando…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            Sin resultados en este filtro.
          </div>
        ) : (
          filtered.map((q) => (
            <div key={q.message_id} className="card p-3 space-y-1.5">
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{q.content}</p>
              <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                <span className="text-gray-400">
                  {q.customer_name ?? q.phone_number}
                </span>
                {q.customer_name && (
                  <span className="text-gray-600">{q.phone_number}</span>
                )}
                <span>{formatFull(q.created_at)}</span>
                {q.escalated && (
                  <span className="px-2 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400">
                    escalado
                  </span>
                )}
                {q.handoff_detected && (
                  <span className="px-2 py-0.5 rounded-full bg-red-900/40 text-red-400">
                    handoff
                  </span>
                )}
                <a
                  href={`https://wa.me/${q.phone_number.replace(/^\+/, '')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-whatsapp-600 hover:text-whatsapp-500"
                >
                  WhatsApp →
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
