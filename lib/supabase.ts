import { createClient } from '@supabase/supabase-js';
import { createBrowserClient as createBrowserClientSSR } from '@supabase/ssr';
import type { Conversation, Message, Product, AgentProduct, Handoff, KnowledgeEntry } from './types';

// ── Server-side client (service role — full access) ─────────
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

// ── Browser client (anon key — for frontend auth) ──────────
// Uses @supabase/ssr's createBrowserClient so sessions are persisted as
// cookies (not localStorage). This is REQUIRED because the Next.js middleware
// reads auth from cookies — storing the session only in localStorage caused
// signInWithPassword() to succeed silently but then /dashboard would bounce
// back to /login forever (spinner-stuck UX).
//
// Cached as a module-level singleton to avoid "Multiple GoTrueClient instances"
// warnings when React re-renders.
let _browserClient: ReturnType<typeof createBrowserClientSSR> | null = null;
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';
  if (typeof window === 'undefined') {
    // Called during SSR — return a fresh (un-cached) instance.
    return createBrowserClientSSR(url, key);
  }
  if (_browserClient) return _browserClient;
  _browserClient = createBrowserClientSSR(url, key);
  return _browserClient;
}

// ============================================================
// Conversation helpers (used by webhook)
// ============================================================

/**
 * Normalize a phone number to E.164 with leading '+'. Tolerant of Twilio
 * variants like "whatsapp:+15551234567" or bare digits "15551234567".
 */
export function normalizePhone(raw: string): string {
  if (!raw) return raw;
  let p = raw.trim();
  if (p.startsWith('whatsapp:')) p = p.slice('whatsapp:'.length);
  p = p.replace(/\s+/g, '');
  if (!p.startsWith('+')) p = '+' + p.replace(/[^\d]/g, '');
  else p = '+' + p.slice(1).replace(/[^\d]/g, '');
  return p;
}

/**
 * Get or create a conversation by phone number.
 * Returns the conversation row.
 *
 * Matching is tolerant of legacy rows that were stored without a leading '+'.
 * New rows are always written in canonical E.164 form ('+' + digits).
 */
export async function getOrCreateConversation(
  phone: string,
  customerName?: string
): Promise<Conversation> {
  const supabase = createServiceClient();

  const canonical = normalizePhone(phone);
  const noPlus = canonical.startsWith('+') ? canonical.slice(1) : canonical;

  // Try both canonical and no-plus forms so we collapse onto existing rows
  // even if they were inserted under a different normalization.
  const { data: matches, error: matchErr } = await supabase
    .from('conversations')
    .select('*')
    .in('phone_number', [canonical, noPlus])
    .order('updated_at', { ascending: false })
    .limit(1);

  if (matchErr) {
    console.warn('[getOrCreateConversation] lookup error:', matchErr.message);
  }

  const existing = matches?.[0];
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (existing.phone_number !== canonical) patch.phone_number = canonical;
    if (customerName && !existing.customer_name) patch.customer_name = customerName;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { data: updated, error: updErr } = await supabase
        .from('conversations')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();
      if (updErr) console.warn('[getOrCreateConversation] update error:', updErr.message);
      return updated ?? existing;
    }
    return existing;
  }

  // Create new (canonical form)
  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      phone_number: canonical,
      customer_name: customerName ?? null,
      customer_segment: 'unknown',
      status: 'active',
      escalated: false,
    })
    .select()
    .single();

  if (error || !created) {
    throw new Error(`Failed to create conversation: ${error?.message}`);
  }

  console.log(`[getOrCreateConversation] created new | phone=${canonical} | id=${created.id}`);
  return created;
}

/**
 * Load the last N messages for a conversation (for Claude context).
 */
export async function loadRecentMessages(
  conversationId: string,
  limit = 20
): Promise<Message[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load messages: ${error.message}`);

  // Return in chronological order
  return (data ?? []).reverse();
}

/**
 * Store a message in the messages table.
 * Optionally pass a Twilio MessageSid for idempotent inserts.
 */
export async function storeMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  handoffDetected = false,
  twilioMessageSid?: string | null
): Promise<Message> {
  const supabase = createServiceClient();

  const payload: Record<string, unknown> = {
    conversation_id: conversationId,
    role,
    content,
    handoff_detected: handoffDetected,
  };
  if (twilioMessageSid) payload.twilio_message_sid = twilioMessageSid;

  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to store message: ${error?.message}`);
  }

  // Update conversation's updated_at. If this fails the dashboard ordering
  // will stale; log it so we don't silently drift.
  const { error: bumpErr } = await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (bumpErr) {
    console.warn(
      `[storeMessage] updated_at bump failed | conv=${conversationId}: ${bumpErr.message}`
    );
  }

  return data;
}

/**
 * Returns true if we've already persisted a message with this Twilio SID.
 * Used for webhook idempotency against retries.
 */
export async function hasProcessedMessageSid(sid: string): Promise<boolean> {
  if (!sid) return false;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('twilio_message_sid', sid)
    .limit(1)
    .maybeSingle();
  if (error) {
    // If the column doesn't exist yet (migration not applied), fail open.
    console.warn('[IDEMPOTENCY] sid check failed:', error.message);
    return false;
  }
  return !!data;
}

/**
 * Count how many user messages came from a given phone number in the past `minutes`.
 * Used for per-phone rolling-window rate limiting.
 */
export async function countRecentUserMessagesFromPhone(
  phoneNumber: string,
  minutes: number
): Promise<number> {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - minutes * 60_000).toISOString();

  // Join via conversations
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('phone_number', phoneNumber)
    .maybeSingle();
  if (!conv?.id) return 0;

  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conv.id)
    .eq('role', 'user')
    .gte('created_at', since);

  return count ?? 0;
}

/**
 * Mark a conversation as opted-out. The webhook should refuse to send
 * further AI messages to this phone until the operator clears the flag.
 */
export async function optOutConversation(conversationId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from('conversations')
    .update({
      status: 'closed',
      escalation_reason: 'user_opt_out',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

/**
 * Mark a conversation as escalated and log the handoff.
 */
export async function escalateConversation(
  conversationId: string,
  reason: string,
  lastCustomerMessage: string
): Promise<void> {
  const supabase = createServiceClient();

  await supabase
    .from('conversations')
    .update({
      escalated: true,
      status: 'escalated',
      escalation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  await supabase.from('handoffs').insert({
    conversation_id: conversationId,
    reason,
    last_customer_message: lastCustomerMessage,
    resolved: false,
  });
}

/**
 * De-escalate a conversation (return to AI mode).
 */
export async function deescalateConversation(conversationId: string): Promise<void> {
  const supabase = createServiceClient();

  await supabase
    .from('conversations')
    .update({
      escalated: false,
      status: 'active',
      escalation_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Mark any open handoffs as resolved
  await supabase
    .from('handoffs')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('resolved', false);
}

/**
 * Get conversation by phone number (no upsert).
 */
export async function getConversationByPhone(phone: string): Promise<Conversation | null> {
  const supabase = createServiceClient();

  const { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phone)
    .single();

  return data ?? null;
}

// ============================================================
// Product helpers (used by webhook to build Sol's context)
// ============================================================

/**
 * Load all in-stock products from agent_product_catalog for Sol's context window.
 */
export async function loadAgentCatalog(): Promise<AgentProduct[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('agent_product_catalog')
    .select('*')
    .eq('in_stock', true)
    .order('category')
    .order('sell_price');

  if (error) throw new Error(`Failed to load agent catalog: ${error.message}`);

  return data ?? [];
}

/**
 * Format agent products into a concise catalog string for Sol's system prompt.
 * Shows customer-facing prices: cuba_total_price for Cuba customers, sell_price for USA.
 * @param products Array of AgentProduct from agent_product_catalog
 * @param region 'cuba' or 'usa' - determines which price to show
 */
export function formatProductCatalogForPrompt(products: AgentProduct[], region: 'cuba' | 'usa' = 'cuba'): string {
  const categoryNames: Record<string, string> = {
    kit: 'ESTACIONES PORTÁTILES',
    battery: 'BATERÍAS DE LITIO',
    inverter: 'INVERSORES SOLARES',
    panel: 'PANELES SOLARES',
    'sistemas-solares-todo-en-uno': 'SISTEMAS TODO-EN-UNO',
    accessory: 'ACCESORIOS',
  };

  const grouped: Record<string, AgentProduct[]> = {};
  for (const p of products) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  const lines: string[] = ['=== CATÁLOGO ACTUAL DE OIIKON ==='];

  for (const [cat, prods] of Object.entries(grouped)) {
    lines.push(`\n${categoryNames[cat] ?? cat.toUpperCase()}`);
    for (const p of prods) {
      const specs: string[] = [];

      // Add relevant specs based on product type
      if (p.battery_capacity_wh) specs.push(`${p.battery_capacity_wh.toLocaleString()}Wh`);
      if (p.battery_capacity_ah) specs.push(`${p.battery_capacity_ah}Ah`);
      if (p.inverter_watts) specs.push(`${p.inverter_watts.toLocaleString()}W inversor`);
      if (p.output_watts && p.category === 'kit') specs.push(`${p.output_watts.toLocaleString()}W salida`);
      if (p.panel_watts) specs.push(`${p.panel_watts}W panel`);
      if (p.solar_input_watts) specs.push(`${p.solar_input_watts.toLocaleString()}W solar`);

      const specsStr = specs.length ? ` (${specs.join(', ')})` : '';

      // Show region-specific price
      const price = region === 'cuba' ? p.cuba_total_price : p.sell_price;
      const priceLabel = region === 'cuba' ? 'Precio Final Cuba' : 'Precio USA';

      lines.push(
        `• ${p.name}${specsStr}: $${price.toFixed(2)} USD (${priceLabel})`
      );
      if (p.ideal_for) lines.push(`  Ideal para: ${p.ideal_for}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Dashboard helpers (used by frontend API routes)
// ============================================================

export async function getDashboardStats() {
  const supabase = createServiceClient();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [{ count: total }, { count: active }, { count: escalated }, { count: closed }, { count: msgsToday }] =
    await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'escalated'),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
      supabase.from('messages').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
    ]);

  return {
    total_conversations: total ?? 0,
    active_conversations: active ?? 0,
    escalated_conversations: escalated ?? 0,
    closed_conversations: closed ?? 0,
    messages_today: msgsToday ?? 0,
  };
}

// ============================================================
// Knowledge Base helpers (agent learning)
// ============================================================

/**
 * Load all knowledge base entries for Sol's context.
 */
export async function loadKnowledgeBase(): Promise<KnowledgeEntry[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .order('times_used', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[KB] Failed to load knowledge base:', error.message);
    return [];
  }

  return data ?? [];
}

/**
 * Add a new knowledge base entry (from operator /teach command).
 */
export async function addKnowledgeEntry(
  question: string,
  answer: string,
  category = 'general'
): Promise<KnowledgeEntry | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('knowledge_base')
    .insert({ question, answer, category, source: 'operator' })
    .select()
    .single();

  if (error) {
    console.error('[KB] Failed to add knowledge entry:', error.message);
    return null;
  }

  return data;
}

/**
 * Increment the times_used counter for a knowledge entry.
 */
export async function incrementKnowledgeUsage(entryId: string): Promise<void> {
  const supabase = createServiceClient();

  try {
    const { error } = await supabase.rpc('increment_kb_usage', { entry_id: entryId });
    if (error) {
      // Fallback: manual increment if RPC doesn't exist
      await supabase
        .from('knowledge_base')
        .update({ times_used: 1 })
        .eq('id', entryId);
    }
  } catch {
    // Silently ignore if increment fails
  }
}

/**
 * Format knowledge base entries for Sol's system prompt.
 */
export function formatKnowledgeBaseForPrompt(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = [
    '\n=== BASE DE CONOCIMIENTO (preguntas frecuentes aprendidas) ===',
    'Usa esta información para responder preguntas similares:\n',
  ];

  for (const entry of entries) {
    lines.push(`P: ${entry.question}`);
    lines.push(`R: ${entry.answer}`);
    lines.push('');
  }

  return lines.join('\n');
}
