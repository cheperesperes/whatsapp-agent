'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { Conversation, Message } from '@/lib/types';

// Poll the API routes every N ms. The dashboard used to subscribe to Supabase
// postgres_changes directly with the anon key, but RLS (correctly) filters
// those rows to zero for the logged-in admin, so realtime events never fired.
// Server-side API routes + polling keep this simple and RLS-safe.
const POLL_MS = 5000;

// ── Helpers ─────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7) return d.toLocaleDateString('es-ES', { weekday: 'short' });
  return d.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' });
}

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: Conversation['status'] }) {
  if (status === 'escalated') return <span className="badge-escalated">🔴 Escalado</span>;
  if (status === 'active') return <span className="badge-active">● Activo</span>;
  return <span className="badge-closed">○ Cerrado</span>;
}

// ── Conversation List Item ───────────────────────────────────

interface ConvItemProps {
  conv: Conversation & { last_message?: Message };
  isSelected: boolean;
  onClick: () => void;
}

function ConvItem({ conv, isSelected, onClick }: ConvItemProps) {
  const displayName = conv.customer_name ?? conv.phone_number;
  const preview = conv.last_message?.content ?? 'Sin mensajes';
  const time = conv.last_message?.created_at ?? conv.created_at;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-3 flex items-start gap-3 rounded-lg transition-colors
        ${isSelected ? 'bg-surface-700' : 'hover:bg-surface-700/50'}`}
    >
      {/* Avatar */}
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 mt-0.5
        ${conv.escalated ? 'bg-red-900 text-red-300' : 'bg-brand-900 text-brand-300'}`}>
        {displayName[0].toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-200 truncate">{displayName}</span>
          <span className="text-xs text-gray-500 shrink-0">{formatTime(time)}</span>
        </div>
        <p className="text-xs text-gray-500 truncate mt-0.5">{preview.slice(0, 60)}</p>
        {conv.escalated && (
          <div className="mt-1">
            <span className="text-xs text-red-400">🔴 Requiere atención</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Chat Thread ──────────────────────────────────────────────

function ChatThread({
  messages,
  onAddToKB,
}: {
  messages: Message[];
  onAddToKB: (msg: Message, suggestedAnswer: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        No hay mensajes aún
      </div>
    );
  }

  // For each user message, find the next assistant message as suggested answer
  const suggestedAnswers: Record<string, string> = {};
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const next = messages.slice(i + 1).find((m) => m.role === 'assistant');
      if (next) suggestedAnswers[msg.id] = next.content;
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {messages.map((msg) => {
        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="flex justify-center">
              <div className="bubble-system max-w-xs">
                {msg.handoff_detected ? `⚠️ Escalado: ${msg.content}` : msg.content}
              </div>
            </div>
          );
        }

        if (msg.role === 'user') {
          return (
            <div key={msg.id} className="flex flex-col items-start gap-1 group">
              <div className="flex items-end gap-2">
                <div className="bubble-user">{msg.content}</div>
                <button
                  type="button"
                  onClick={() => onAddToKB(msg, suggestedAnswers[msg.id] ?? '')}
                  title="Agregar a la base de conocimiento"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded-md bg-surface-700 hover:bg-brand-600 text-gray-300 hover:text-white border border-surface-500 shrink-0"
                >
                  + KB
                </button>
              </div>
              <span className="text-xs text-gray-600 ml-1">{formatFull(msg.created_at)}</span>
            </div>
          );
        }

        return (
          <div key={msg.id} className="flex flex-col items-end gap-1 group">
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => onAddToKB(msg, msg.content)}
                title="Agregar respuesta a la base de conocimiento"
                className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded-md bg-surface-700 hover:bg-brand-600 text-gray-300 hover:text-white border border-surface-500 shrink-0"
              >
                + KB
              </button>
              <div className="bubble-assistant">{msg.content}</div>
            </div>
            {msg.handoff_detected && (
              <span className="text-xs text-yellow-500">⚠️ Handoff detectado</span>
            )}
            <span className="text-xs text-gray-600 mr-1">{formatFull(msg.created_at)}</span>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Add-to-KB Modal ─────────────────────────────────────────

function KBModal({
  initialQuestion,
  initialAnswer,
  onSave,
  onClose,
}: {
  initialQuestion: string;
  initialAnswer: string;
  onSave: (question: string, answer: string, category: string) => Promise<void>;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState(initialAnswer);
  const [category, setCategory] = useState('general');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!question.trim() || !answer.trim()) {
      setError('Pregunta y respuesta son requeridas.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(question.trim(), answer.trim(), category.trim() || 'general');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">
            Agregar a la base de conocimiento
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <p className="text-xs text-gray-500">
          Sol usará esta pregunta/respuesta como referencia para futuras conversaciones.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Pregunta</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              className="input w-full resize-none"
              placeholder="¿Cuánto tarda el envío a Cuba?"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Respuesta</label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              className="input w-full resize-none"
              placeholder="El envío a Cuba tarda entre 2-4 semanas..."
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Categoría</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input w-full"
              placeholder="general, envio, precios..."
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
            onClick={onClose}
            disabled={saving}
            className="btn-secondary text-xs"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn-primary text-xs"
          >
            {saving ? 'Guardando...' : 'Guardar en KB'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Customer Card ────────────────────────────────────────────

interface CustomerCardProps {
  conv: Conversation;
  onDeescalate: () => void;
  onClose: () => void;
  loading: boolean;
}

function CustomerCard({ conv, onDeescalate, onClose, loading }: CustomerCardProps) {
  const segmentLabels: Record<string, string> = {
    cuban_family: 'Familia cubana',
    general: 'Cliente general',
    unknown: 'Desconocido',
  };

  return (
    <div className="w-64 shrink-0 border-l border-surface-600 bg-surface-800 flex flex-col p-4 gap-4 overflow-y-auto">
      <h3 className="text-sm font-semibold text-gray-300">Info del cliente</h3>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-gray-500">Teléfono</p>
          <p className="text-sm text-gray-200 font-mono">{conv.phone_number}</p>
        </div>

        {conv.customer_name && (
          <div>
            <p className="text-xs text-gray-500">Nombre</p>
            <p className="text-sm text-gray-200">{conv.customer_name}</p>
          </div>
        )}

        <div>
          <p className="text-xs text-gray-500">Segmento</p>
          <p className="text-sm text-gray-200">{segmentLabels[conv.customer_segment] ?? conv.customer_segment}</p>
        </div>

        {conv.product_interest && (
          <div>
            <p className="text-xs text-gray-500">Interés en</p>
            <p className="text-sm text-gray-200">{conv.product_interest}</p>
          </div>
        )}

        <div>
          <p className="text-xs text-gray-500">Estado</p>
          <StatusBadge status={conv.status} />
        </div>

        {conv.escalation_reason && (
          <div>
            <p className="text-xs text-gray-500">Razón de escalamiento</p>
            <p className="text-sm text-red-400">{conv.escalation_reason}</p>
          </div>
        )}

        <div>
          <p className="text-xs text-gray-500">Inicio</p>
          <p className="text-sm text-gray-400">{formatFull(conv.created_at)}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-auto space-y-2">
        {conv.escalated && (
          <button
            type="button"
            onClick={onDeescalate}
            disabled={loading}
            className="btn-primary w-full text-xs"
          >
            {loading ? 'Procesando...' : 'Devolver a Sol (AI)'}
          </button>
        )}

        {conv.status !== 'closed' && (
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="btn-secondary w-full text-xs"
          >
            Marcar como cerrado
          </button>
        )}

        <a
          href={`https://wa.me/${conv.phone_number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary w-full text-xs flex items-center justify-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
          Ver en WhatsApp
        </a>
      </div>
    </div>
  );
}

// ── Main Dashboard Page ──────────────────────────────────────

type ConvWithLast = Conversation & { last_message?: Message };

export default function DashboardPage() {
  const [conversations, setConversations] = useState<ConvWithLast[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'escalated' | 'closed'>('all');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [kbModal, setKbModal] = useState<{ question: string; answer: string } | null>(null);
  const [kbToast, setKbToast] = useState<string | null>(null);

  // Load conversations via server API (service-role, RLS-bypassing)
  const loadConversations = useCallback(async (opts?: { showSpinner?: boolean }) => {
    if (opts?.showSpinner) setLoading(true);
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' });
      if (!res.ok) return;
      const { conversations: convs } = (await res.json()) as { conversations: ConvWithLast[] };
      setConversations(convs ?? []);

      // Auto-select first escalated, or first overall — only on initial load
      setSelectedId((current) => {
        if (current) return current;
        const firstEscalated = convs?.find((c) => c.escalated);
        if (firstEscalated) return firstEscalated.id;
        if (convs && convs.length > 0) return convs[0].id;
        return null;
      });
    } finally {
      if (opts?.showSpinner) setLoading(false);
    }
  }, []);

  // Load messages for selected conversation
  const loadMessages = useCallback(async (convId: string) => {
    const res = await fetch(`/api/conversations/${convId}/messages`, { cache: 'no-store' });
    if (!res.ok) return;
    const { messages: data } = (await res.json()) as { messages: Message[] };
    setMessages(data ?? []);
  }, []);

  // Initial load
  useEffect(() => { loadConversations({ showSpinner: true }); }, [loadConversations]);

  useEffect(() => {
    if (selectedId) loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Polling — refresh conversations list and the open thread
  useEffect(() => {
    const t = setInterval(() => {
      loadConversations();
      if (selectedId) loadMessages(selectedId);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadConversations, loadMessages, selectedId]);

  // Selected conversation object
  const selectedConv = conversations.find((c) => c.id === selectedId) ?? null;

  // Filtered conversations
  const filtered = conversations.filter((c) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'escalated' && c.escalated) ||
      (filter === 'active' && c.status === 'active' && !c.escalated) ||
      (filter === 'closed' && c.status === 'closed');

    const matchesSearch =
      !search ||
      c.phone_number.includes(search) ||
      (c.customer_name?.toLowerCase().includes(search.toLowerCase()) ?? false);

    return matchesFilter && matchesSearch;
  });

  // Actions — POST to server API which uses service role
  async function postAction(action: 'deescalate' | 'close') {
    if (!selectedConv) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/conversations/${selectedConv.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[DASHBOARD] ${action} failed: ${res.status}`, text);
        alert(
          `No se pudo ${action === 'close' ? 'cerrar' : 'devolver a Sol'} la conversación.\n` +
            `Status: ${res.status}\n${text.slice(0, 200)}`
        );
      }
    } catch (err) {
      console.error(`[DASHBOARD] ${action} network error:`, err);
      alert(`Error de red al ${action === 'close' ? 'cerrar' : 'devolver a Sol'}. Revise la consola.`);
    } finally {
      setActionLoading(false);
      loadConversations();
    }
  }

  async function handleDeescalate() {
    await postAction('deescalate');
  }

  async function handleClose() {
    await postAction('close');
  }

  function openKBModal(msg: Message, suggestedAnswer: string) {
    const isUserMsg = msg.role === 'user';
    setKbModal({
      question: isUserMsg ? msg.content : '',
      answer: isUserMsg ? suggestedAnswer : msg.content,
    });
  }

  async function handleSaveKB(question: string, answer: string, category: string) {
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, answer, category }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`No se pudo guardar: ${res.status} ${text.slice(0, 120)}`);
    }
    setKbModal(null);
    setKbToast('✓ Agregado a la base de conocimiento');
    setTimeout(() => setKbToast(null), 2500);
  }

  // Stats bar
  const escalatedCount = conversations.filter((c) => c.escalated).length;
  const activeCount = conversations.filter((c) => c.status === 'active').length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold text-white">Conversaciones</h2>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="badge-active">{activeCount} activas</span>
            {escalatedCount > 0 && (
              <span className="badge-escalated">{escalatedCount} escaladas</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Conversation List */}
        <div className="w-72 shrink-0 flex flex-col border-r border-surface-600 bg-surface-800">
          {/* Search + Filter */}
          <div className="p-3 space-y-2 border-b border-surface-600">
            <input
              type="text"
              placeholder="Buscar por número o nombre..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-full text-xs"
            />
            <div className="flex gap-1">
              {(['all', 'escalated', 'active', 'closed'] as const).map((f) => (
                <button
                  type="button"
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`flex-1 text-xs py-1 rounded-md transition-colors
                    ${filter === f ? 'bg-brand-500 text-white' : 'bg-surface-700 text-gray-400 hover:text-gray-200'}`}
                >
                  {f === 'all' ? 'Todos' : f === 'escalated' ? '🔴' : f === 'active' ? 'Activos' : 'Cerrados'}
                </button>
              ))}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {loading && conversations.length === 0 ? (
              <div className="text-center text-gray-600 text-sm py-8">Cargando...</div>
            ) : filtered.length === 0 ? (
              <div className="text-center text-gray-600 text-sm py-8">
                {search ? 'Sin resultados' : 'No hay conversaciones'}
              </div>
            ) : (
              filtered.map((conv) => (
                <ConvItem
                  key={conv.id}
                  conv={conv}
                  isSelected={conv.id === selectedId}
                  onClick={() => setSelectedId(conv.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Chat Area */}
        {selectedConv ? (
          <div className="flex flex-1 min-w-0">
            {/* Chat Thread */}
            <div className="flex flex-col flex-1 min-w-0">
              {/* Chat Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-surface-600 bg-surface-800 shrink-0">
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    {selectedConv.customer_name ?? selectedConv.phone_number}
                  </p>
                  <p className="text-xs text-gray-500">{selectedConv.phone_number}</p>
                </div>
                <StatusBadge status={selectedConv.status} />
              </div>

              {/* Messages */}
              <ChatThread messages={messages} onAddToKB={openKBModal} />
            </div>

            {/* Customer Card */}
            <CustomerCard
              conv={selectedConv}
              onDeescalate={handleDeescalate}
              onClose={handleClose}
              loading={actionLoading}
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-sm">Seleccione una conversación</p>
            </div>
          </div>
        )}
      </div>

      {kbModal && (
        <KBModal
          initialQuestion={kbModal.question}
          initialAnswer={kbModal.answer}
          onSave={handleSaveKB}
          onClose={() => setKbModal(null)}
        />
      )}

      {kbToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-brand-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {kbToast}
        </div>
      )}
    </div>
  );
}
