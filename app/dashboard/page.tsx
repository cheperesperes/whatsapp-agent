'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useRef, useCallback } from 'react';
import { createBrowserClient } from '@/lib/supabase';
import type { Conversation, Message } from '@/lib/types';

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

function ChatThread({ messages }: { messages: Message[] }) {
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
            <div key={msg.id} className="flex flex-col items-start gap-1">
              <div className="bubble-user">{msg.content}</div>
              <span className="text-xs text-gray-600 ml-1">{formatFull(msg.created_at)}</span>
            </div>
          );
        }

        return (
          <div key={msg.id} className="flex flex-col items-end gap-1">
            <div className="bubble-assistant">{msg.content}</div>
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

  const supabase = createBrowserClient();

  // Load conversations
  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const { data: convs } = await supabase
        .from('conversations')
        .select('*')
        .order('updated_at', { ascending: false });

      if (!convs) return;

      // Load last message for each conversation
      const withLast: ConvWithLast[] = await Promise.all(
        convs.map(async (conv) => {
          const { data: lastMsg } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          return { ...conv, last_message: lastMsg ?? undefined };
        })
      );

      setConversations(withLast);

      // Auto-select first escalated, or first overall
      if (!selectedId) {
        const firstEscalated = withLast.find((c) => c.escalated);
        if (firstEscalated) setSelectedId(firstEscalated.id);
        else if (withLast.length > 0) setSelectedId(withLast[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [supabase, selectedId]);

  // Load messages for selected conversation
  const loadMessages = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });
    setMessages(data ?? []);
  }, [supabase]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadConversations(); }, []);

  useEffect(() => {
    if (selectedId) loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Realtime subscriptions
  useEffect(() => {
    const convChannel = supabase
      .channel('conversations-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {
        loadConversations();
      })
      .subscribe();

    const msgChannel = supabase
      .channel('messages-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const newMsg = payload.new as Message;
        if (newMsg.conversation_id === selectedId) {
          setMessages((prev) => [...prev, newMsg]);
        }
        // Refresh conversation list to update last message preview
        loadConversations();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(convChannel);
      supabase.removeChannel(msgChannel);
    };
  }, [supabase, selectedId, loadConversations]);

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

  // Actions
  async function handleDeescalate() {
    if (!selectedConv) return;
    setActionLoading(true);
    await supabase
      .from('conversations')
      .update({ escalated: false, status: 'active', escalation_reason: null, updated_at: new Date().toISOString() })
      .eq('id', selectedConv.id);
    await supabase
      .from('handoffs')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('conversation_id', selectedConv.id)
      .eq('resolved', false);
    setActionLoading(false);
    loadConversations();
  }

  async function handleClose() {
    if (!selectedConv) return;
    setActionLoading(true);
    await supabase
      .from('conversations')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', selectedConv.id);
    setActionLoading(false);
    loadConversations();
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
              <ChatThread messages={messages} />
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
    </div>
  );
}
