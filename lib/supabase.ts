import { createClient } from '@supabase/supabase-js';
import type { Conversation, Message, Product, Handoff } from './types';

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
export function createBrowserClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';
  return createClient(url, key);
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
 * Load all in-stock products for Sol's context window.
 */
export async function loadProducts(): Promise<Product[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('in_stock', true)
    .order('category')
    .order('price_usd');

  if (error) throw new Error(`Failed to load products: ${error.message}`);

  return data ?? [];
}

/**
 * Format products into a concise catalog string for Sol's system prompt.
 */
export function formatProductCatalogForPrompt(products: Product[]): string {
  const categoryNames: Record<string, string> = {
    portable_station: 'ESTACIONES PORTÁTILES PECRON',
    battery: 'BATERÍAS DE LITIO (requieren inversor)',
    inverter: 'INVERSORES SOLARES',
    panel: 'PANELES SOLARES',
    all_in_one: 'SISTEMAS TODO-EN-UNO',
    accessory: 'ACCESORIOS',
  };

  const grouped: Record<string, Product[]> = {};
  for (const p of products) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  const lines: string[] = ['=== CATÁLOGO ACTUAL DE OIIKON ==='];

  for (const [cat, prods] of Object.entries(grouped)) {
    lines.push(`\n${categoryNames[cat] ?? cat.toUpperCase()}`);
    for (const p of prods) {
      const specs: string[] = [];
      if (p.capacity_wh) specs.push(`${p.capacity_wh.toLocaleString()}Wh`);
      if (p.output_watts) specs.push(`${p.output_watts.toLocaleString()}W salida`);
      const specsStr = specs.length ? ` (${specs.join(', ')})` : '';
      const shipping = p.price_includes_cuba_shipping ? ' — envío a Cuba incluido' : '';
      lines.push(
        `• ${p.name}${specsStr}: $${p.price_usd.toFixed(2)} USD${shipping}`
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
