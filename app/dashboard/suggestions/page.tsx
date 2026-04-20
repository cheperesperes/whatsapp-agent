'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';
import type { KBSuggestion, KBSuggestionStatus } from '@/lib/types';

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

type Filter = KBSuggestionStatus | 'all';

export default function SuggestionsPage() {
  const [suggestions, setSuggestions] = useState<KBSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('pending');
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/kb-suggestions?status=${filter}`, { cache: 'no-store' });
    if (res.ok) {
      const { suggestions: data } = (await res.json()) as { suggestions: KBSuggestion[] };
      setSuggestions(data ?? []);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(id: string, action: 'approve' | 'reject') {
    setActingId(id);
    try {
      const res = await fetch(`/api/kb-suggestions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        alert(`Error: ${res.status} ${txt.slice(0, 120)}`);
        return;
      }
      await load();
    } finally {
      setActingId(null);
    }
  }

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'pending', label: 'Pendientes' },
    { key: 'approved', label: 'Aprobadas' },
    { key: 'rejected', label: 'Rechazadas' },
    { key: 'all', label: 'Todas' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-gray-100">Sugerencias de Sol</h2>
          <span className="text-xs text-gray-400">{suggestions.length} en esta vista</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
              filter === f.key
                ? 'bg-whatsapp-500/15 text-whatsapp-600'
                : 'bg-surface-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="text-center text-gray-500 text-sm py-8">Cargando...</div>
        ) : suggestions.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            {filter === 'pending'
              ? 'No hay sugerencias pendientes. Sol aprende de cada conversación — vuelva más tarde.'
              : 'Sin resultados.'}
          </div>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="card p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200">{s.question}</p>
                  <p className="text-sm text-gray-400 mt-1.5 whitespace-pre-wrap">{s.answer}</p>
                  {s.rationale && (
                    <p className="text-xs text-gray-500 italic mt-2">💡 {s.rationale}</p>
                  )}
                </div>
                {s.status === 'pending' && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleAction(s.id, 'approve')}
                      disabled={actingId === s.id}
                      className="btn-primary text-xs"
                    >
                      {actingId === s.id ? '…' : 'Aprobar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(s.id, 'reject')}
                      disabled={actingId === s.id}
                      className="btn-danger text-xs"
                    >
                      Rechazar
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-400">
                  {s.category}
                </span>
                <span className={`px-2 py-0.5 rounded-full ${
                  s.status === 'pending'
                    ? 'bg-yellow-900/40 text-yellow-400'
                    : s.status === 'approved'
                      ? 'bg-green-900/40 text-green-400'
                      : 'bg-red-900/40 text-red-400'
                }`}>
                  {s.status}
                </span>
                <span>{formatFull(s.created_at)}</span>
                {s.reviewed_at && <span>Revisado: {formatFull(s.reviewed_at)}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
