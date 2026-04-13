import { createClient } from '@supabase/supabase-js';
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
// Uses @supabase/supabase-js directly for browser pages.
// @supabase/ssr is only needed in the middleware for server-side cookie handling.
// Placeholder fallbacks let `next build` succeed without real env vars configured.
//
// IMPORTANT: cached as a module-level singleton. Calling createClient() on every
// React render spawns multiple GoTrueClient instances that fight over the same
// localStorage auth key, which can hang signInWithPassword() indefinitely.
let _browserClient: ReturnType<typeof createClient> | null = null;
export function createBrowserClient() {
  if (typeof window === 'undefined') {
    // On the server (SSR), always create fresh — no persistence.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';
    return createClient(url, key);
  }
  if (_browserClient) return _browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';
  _browserClient = createClient(url, key);
  return _browserClient;
}

// ============================================================
// Conversation helpers (used by webhook)
// ============================================================

/**
 * Get or create a conversation by phone number.
 * Returns the conversation row.
 */
export async function getOrCreateConversation(
  phone: string,
  customerName?: string
): Promise<Conversation> {
  const supabase = createServiceClient();

  // Try to find existing
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (existing) {
    // Update name if provided and not already set
    if (customerName && !existing.customer_name) {
      const { data: updated } = await supabase
        .from('conversations')
        .update({ customer_name: customerName, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      return updated ?? existing;
    }
    return existing;
  }

  // Create new
  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      phone_number: phone,
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
 */
export async function storeMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  handoffDetected = false
): Promise<Message> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role,
      content,
      handoff_detected: handoffDetected,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to store message: ${error?.message}`);
  }

  // Update conversation's updated_at
  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  return data;
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
