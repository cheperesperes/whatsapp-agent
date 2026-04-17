'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';
import type { KnowledgeEntry } from '@/lib/types';

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/knowledge', { cache: 'no-store' });
    if (res.ok) {
      const { entries: data } = (await res.json()) as { entries: KnowledgeEntry[] };
      setEntries(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar esta entrada de la base de conocimiento?')) return;
    const res = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
    if (res.ok) load();
    else alert('No se pudo eliminar');
  }

  async function handleSave(entry: { id?: string; question: string; answer: string; category: string }) {
    if (!entry.question.trim() || !entry.answer.trim()) {
      setError('Pregunta y respuesta son requeridas.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = entry.id ? `/api/knowledge/${entry.id}` : '/api/knowledge';
      const method = entry.id ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: entry.question.trim(),
          answer: entry.answer.trim(),
          category: entry.category.trim() || 'general',
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status} ${txt.slice(0, 120)}`);
      }
      setEditing(null);
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  const filtered = entries.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.question.toLowerCase().includes(q) ||
      e.answer.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-white">Base de Conocimiento</h2>
          <span className="text-xs text-gray-400">{entries.length} entradas</span>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="btn-primary text-xs"
        >
          + Nueva entrada
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por pregunta, respuesta o categoría..."
          className="input w-full max-w-md text-sm"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="text-center text-gray-500 text-sm py-8">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            {search ? 'Sin resultados' : 'No hay entradas aún. Use el botón "+ KB" en una conversación o cree una nueva.'}
          </div>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id} className="card p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200">{entry.question}</p>
                  <p className="text-sm text-gray-400 mt-1.5 whitespace-pre-wrap">{entry.answer}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditing(entry)}
                    className="btn-secondary text-xs"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(entry.id)}
                    className="btn-danger text-xs"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-400">
                  {entry.category}
                </span>
                <span>Fuente: {entry.source}</span>
                <span>Usos: {entry.times_used}</span>
                <span>{formatFull(entry.created_at)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {(editing || creating) && (
        <EntryForm
          initial={editing ?? { id: undefined, question: '', answer: '', category: 'general' }}
          saving={saving}
          error={error}
          onSave={handleSave}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function EntryForm({
  initial,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: { id?: string; question: string; answer: string; category: string };
  saving: boolean;
  error: string | null;
  onSave: (entry: { id?: string; question: string; answer: string; category: string }) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState(initial.question);
  const [answer, setAnswer] = useState(initial.answer);
  const [category, setCategory] = useState(initial.category || 'general');

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-lg p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">
            {initial.id ? 'Editar entrada' : 'Nueva entrada de conocimiento'}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Pregunta</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              className="input w-full resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Respuesta</label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={6}
              className="input w-full resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Categoría</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input w-full"
            />
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="btn-secondary text-xs"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSave({ id: initial.id, question, answer, category })}
            disabled={saving}
            className="btn-primary text-xs"
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
