import { createClient } from '@supabase/supabase-js';
import { createBrowserClient as createBrowserClientSSR } from '@supabase/ssr';
import type {
  Conversation,
  ConversationStatus,
  Message,
  Product,
  AgentProduct,
  Handoff,
  KnowledgeEntry,
  CustomerProfile,
  CustomerProfileFact,
  CustomerQuestion,
  KBSuggestion,
  KBSuggestionStatus,
  LostCustomer,
  OverviewMetrics,
  RepeatedQuestion,
} from './types';

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
      opted_out: true,
      opted_out_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

/**
 * Clear opt-out flag to re-enroll a customer who writes again after opting out.
 */
export async function clearOptOut(conversationId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from('conversations')
    .update({
      opted_out: false,
      opted_out_at: null,
      status: 'active',
      escalation_reason: null,
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

  // Tolerant of both canonical ("+15551234567") and legacy no-plus ("15551234567") forms.
  const canonical = normalizePhone(phone);
  const noPlus = canonical.startsWith('+') ? canonical.slice(1) : canonical;

  const { data } = await supabase
    .from('conversations')
    .select('*')
    .in('phone_number', [canonical, noPlus])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}

// ============================================================
// Product helpers (used by webhook to build Sol's context)
// ============================================================

/**
 * Load all in-stock products from agent_product_catalog for Sol's context window.
 * Enriches each row with `original_price`, `discount_percentage`, and
 * `qualifies_24h_cuba` from the `products` table — those live there only, not
 * in agent_product_catalog, but Sol needs them to communicate offers and fast
 * delivery.
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
  const catalog = data ?? [];
  if (catalog.length === 0) return catalog;

  const skus = catalog.map((p) => p.sku);
  const { data: extras } = await supabase
    .from('products')
    .select('sku, price, original_price, discount_percentage, qualifies_24h_cuba')
    .in('sku', skus);

  const extraBySku = new Map<string, {
    price: number | null;
    original_price: number | null;
    discount_percentage: number | null;
    qualifies_24h_cuba: boolean | null;
  }>();
  for (const row of extras ?? []) {
    extraBySku.set(row.sku.toLowerCase(), row);
  }

  return catalog.map((p) => {
    const extra = extraBySku.get(p.sku.toLowerCase());
    if (!extra) return p;
    // Only surface a discount when both fields agree — otherwise data is noisy
    // (some rows have discount_percentage set but original_price equals price).
    const hasRealDiscount =
      extra.discount_percentage != null &&
      extra.discount_percentage > 0 &&
      extra.original_price != null &&
      extra.price != null &&
      extra.original_price > extra.price;
    return {
      ...p,
      original_price: hasRealDiscount ? extra.original_price : null,
      discount_percentage: hasRealDiscount ? extra.discount_percentage : null,
      qualifies_24h_cuba: !!extra.qualifies_24h_cuba,
    };
  });
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
      if (p.supports_external_battery) specs.push('expandible con batería externa');

      const specsStr = specs.length ? ` (${specs.join(', ')})` : '';

      // Show region-specific price
      const price = region === 'cuba' ? p.cuba_total_price : p.sell_price;
      const priceLabel = region === 'cuba' ? 'Precio Final Cuba' : 'Precio USA';

      lines.push(
        `• ${p.name}${specsStr}: $${price.toFixed(2)} USD (${priceLabel})`
      );
      // Offer: always anchored to the USA sell_price (the web-store list price
      // that `original_price` compares against). Sol should mention the saving
      // naturally, not as a sales-pressure line.
      if (
        p.original_price != null &&
        p.discount_percentage != null &&
        p.original_price > p.sell_price
      ) {
        const pct = Number(p.discount_percentage).toFixed(0);
        lines.push(
          `  🔥 OFERTA: antes $${Number(p.original_price).toFixed(2)} → ahora $${p.sell_price.toFixed(2)} USD (−${pct}%)`
        );
      }
      if (p.qualifies_24h_cuba) {
        lines.push(
          `  ⚡ Entrega rápida La Habana disponible (hasta 24h desde almacén local)`
        );
      }
      if (p.ideal_for) lines.push(`  Ideal para: ${p.ideal_for}`);
    }
  }

  return lines.join('\n');
}

/**
 * Resolve a product image URL by SKU (case-insensitive).
 * Tries `primary_image_url` → first usable `gallery_images` entry → legacy
 * `image_url` column (which is what oiikon.com itself renders for older
 * products whose primary/gallery were never populated).
 * Unsplash placeholders are skipped. Returns null if nothing usable.
 *
 * WhatsApp/Twilio only accept JPEG and PNG — our storage bucket is 100% webp,
 * so any webp URL is proxied through wsrv.nl which transcodes to JPEG on the
 * fly. Without this the `sendImage` call 400s and the customer gets nothing.
 */
export async function getProductImage(sku: string): Promise<string | null> {
  if (!sku?.trim()) return null;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('products')
    .select('primary_image_url, gallery_images, image_url')
    .ilike('sku', sku.trim())
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const isUsable = (u: unknown): u is string =>
    typeof u === 'string' && u.startsWith('https://') && !u.includes('images.unsplash.com');

  let chosen: string | null = null;
  if (isUsable(data.primary_image_url)) {
    chosen = data.primary_image_url as string;
  } else if (Array.isArray(data.gallery_images)) {
    const first = data.gallery_images.find(isUsable);
    if (first) chosen = first;
  }
  if (!chosen && isUsable(data.image_url)) {
    chosen = data.image_url as string;
  }

  return chosen ? toWhatsAppMediaUrl(chosen) : null;
}

/**
 * WhatsApp (via Twilio) rejects `image/webp`. Wrap webp URLs in the free
 * wsrv.nl image proxy, which fetches the source and serves it as JPEG.
 * Non-webp URLs pass through unchanged.
 */
function toWhatsAppMediaUrl(url: string): string {
  if (!/\.webp(\?|$)/i.test(url)) return url;
  const stripped = url.replace(/^https?:\/\//, '');
  return `https://wsrv.nl/?url=${encodeURIComponent(stripped)}&output=jpg`;
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

// ============================================================
// Customer profiles (auto-learned per-contact facts)
// ============================================================

export async function loadCustomerProfile(phone: string): Promise<CustomerProfile | null> {
  const supabase = createServiceClient();
  const canonical = normalizePhone(phone);
  const { data } = await supabase
    .from('customer_profiles')
    .select('*')
    .eq('phone_number', canonical)
    .maybeSingle();
  return (data as CustomerProfile | null) ?? null;
}

export async function upsertCustomerProfile(
  phone: string,
  patch: {
    display_name?: string | null;
    language?: string | null;
    summary?: string | null;
    facts?: CustomerProfileFact[];
  }
): Promise<void> {
  const supabase = createServiceClient();
  const canonical = normalizePhone(phone);
  const payload: Record<string, unknown> = {
    phone_number: canonical,
    last_extracted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (patch.display_name !== undefined) payload.display_name = patch.display_name;
  if (patch.language !== undefined) payload.language = patch.language;
  if (patch.summary !== undefined) payload.summary = patch.summary;
  if (patch.facts !== undefined) payload.facts = patch.facts;

  const { error } = await supabase
    .from('customer_profiles')
    .upsert(payload, { onConflict: 'phone_number' });
  if (error) console.warn('[profile] upsert error:', error.message);
}

export function formatCustomerProfileForPrompt(profile: CustomerProfile | null): string {
  if (!profile) return '';
  const facts = (profile.facts ?? []).map((f) => `• ${f.fact}`).join('\n');
  const lines: string[] = ['\n=== LO QUE SABEMOS DE ESTE CLIENTE ==='];
  if (profile.display_name) lines.push(`Nombre: ${profile.display_name}`);
  if (profile.language) lines.push(`Idioma preferido: ${profile.language}`);
  if (profile.summary) lines.push(`Resumen: ${profile.summary}`);
  if (facts) lines.push(`Datos confirmados:\n${facts}`);
  lines.push('Usa estos datos para personalizar la conversación; nunca los repitas como si los leyeras de una lista.');
  if (lines.length === 2) return '';
  return lines.join('\n');
}

// ============================================================
// KB suggestion queue (cross-conversation learning)
// ============================================================

export async function listKBSuggestions(status: KBSuggestionStatus | 'all' = 'pending'): Promise<KBSuggestion[]> {
  const supabase = createServiceClient();
  let query = supabase.from('kb_suggestions').select('*').order('created_at', { ascending: false });
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) {
    console.error('[kb_suggestions] list error:', error.message);
    return [];
  }
  return (data as KBSuggestion[]) ?? [];
}

export async function createKBSuggestion(input: {
  question: string;
  answer: string;
  category?: string;
  conversation_id?: string | null;
  rationale?: string | null;
}): Promise<KBSuggestion | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('kb_suggestions')
    .insert({
      question: input.question.trim(),
      answer: input.answer.trim(),
      category: input.category?.trim() || 'general',
      source_conversation_id: input.conversation_id ?? null,
      rationale: input.rationale ?? null,
      status: 'pending',
    })
    .select()
    .single();
  if (error) {
    console.warn('[kb_suggestions] insert error:', error.message);
    return null;
  }
  return data as KBSuggestion;
}

export async function approveKBSuggestion(id: string, reviewer?: string): Promise<KnowledgeEntry | null> {
  const supabase = createServiceClient();
  const { data: suggestion, error: selErr } = await supabase
    .from('kb_suggestions')
    .select('*')
    .eq('id', id)
    .single();
  if (selErr || !suggestion) return null;

  const entry = await addKnowledgeEntry(suggestion.question, suggestion.answer, suggestion.category);
  if (!entry) return null;

  await supabase
    .from('kb_suggestions')
    .update({
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer ?? null,
      promoted_entry_id: entry.id,
    })
    .eq('id', id);

  return entry;
}

export async function rejectKBSuggestion(id: string, reviewer?: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('kb_suggestions')
    .update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer ?? null,
    })
    .eq('id', id);
  return !error;
}

// ============================================================
// Customer question feed (derived from messages table)
// Surfaces every user message so the operator can spot gaps in Sol's training.
// ============================================================

type QuestionRow = {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  handoff_detected: boolean;
  conversations: {
    phone_number: string;
    customer_name: string | null;
    status: ConversationStatus;
    escalated: boolean;
  } | null;
};

export async function listCustomerQuestions(opts: {
  mode?: 'questions' | 'all';
  limit?: number;
  sinceDays?: number | null;
} = {}): Promise<CustomerQuestion[]> {
  const supabase = createServiceClient();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const mode = opts.mode ?? 'questions';

  let query = supabase
    .from('messages')
    .select(
      'id, conversation_id, content, created_at, handoff_detected, conversations!inner(phone_number, customer_name, status, escalated)'
    )
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (mode === 'questions') {
    query = query.like('content', '%?%');
  }

  if (opts.sinceDays && opts.sinceDays > 0) {
    const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', since);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[listCustomerQuestions] error:', error.message);
    return [];
  }

  const rows = (data as unknown as QuestionRow[]) ?? [];
  return rows.map((r) => ({
    message_id: r.id,
    conversation_id: r.conversation_id,
    phone_number: r.conversations?.phone_number ?? '',
    customer_name: r.conversations?.customer_name ?? null,
    content: r.content,
    created_at: r.created_at,
    conversation_status: r.conversations?.status ?? 'active',
    escalated: r.conversations?.escalated ?? false,
    handoff_detected: r.handoff_detected,
  }));
}

// ============================================================
// Lost customers — engaged conversations that went silent.
// "Engaged" = 3+ user messages; "silent" = updated_at older than N hours.
// These are the most recoverable leads.
// ============================================================
export async function listLostCustomers(opts: {
  minUserMessages?: number;
  silentHours?: number;
  limit?: number;
} = {}): Promise<LostCustomer[]> {
  const supabase = createServiceClient();
  const minUserMessages = Math.max(opts.minUserMessages ?? 3, 1);
  const silentHours = Math.max(opts.silentHours ?? 24, 1);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const cutoff = new Date(Date.now() - silentHours * 60 * 60 * 1000).toISOString();

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, phone_number, customer_name, escalated, opted_out, status, updated_at')
    .eq('opted_out', false)
    .neq('status', 'closed')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(limit * 3);
  if (error || !convs) {
    console.error('[listLostCustomers] conv fetch error:', error?.message);
    return [];
  }

  const results: LostCustomer[] = [];
  for (const c of convs) {
    const { data: lastMsgs } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const last = lastMsgs?.[0];
    if (!last) continue;

    const { count: userCount } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', c.id)
      .eq('role', 'user');
    if ((userCount ?? 0) < minUserMessages) continue;

    const hoursSilent = Math.round(
      (Date.now() - new Date(last.created_at).getTime()) / (60 * 60 * 1000)
    );

    results.push({
      conversation_id: c.id,
      phone_number: c.phone_number,
      customer_name: c.customer_name,
      user_message_count: userCount ?? 0,
      last_message_at: last.created_at,
      last_message_role: last.role,
      last_message_snippet: last.content.slice(0, 160),
      hours_silent: hoursSilent,
      escalated: c.escalated,
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ============================================================
// Weekly overview — metrics + repeated questions.
// ============================================================

function normalizeQuestionKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[¿?¡!.,:;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

export async function getOverviewMetrics(windowDays = 7): Promise<OverviewMetrics> {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: convsNew },
    { count: msgsUser },
    { count: msgsSol },
    { count: escalated },
    { data: deepData },
  ] = await Promise.all([
    supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('created_at', since),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', since),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('role', 'assistant').gte('created_at', since),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('escalated', true).gte('updated_at', since),
    supabase
      .from('messages')
      .select('conversation_id')
      .eq('role', 'user')
      .gte('created_at', since),
  ]);

  const convCounts = new Map<string, number>();
  for (const row of (deepData ?? []) as { conversation_id: string }[]) {
    convCounts.set(row.conversation_id, (convCounts.get(row.conversation_id) ?? 0) + 1);
  }
  const deep = [...convCounts.values()].filter((n) => n >= 5).length;

  return {
    window_days: windowDays,
    conversations_new: convsNew ?? 0,
    messages_customer: msgsUser ?? 0,
    messages_sol: msgsSol ?? 0,
    escalated: escalated ?? 0,
    deep_conversations: deep,
  };
}

export async function listTopQuestions(windowDays = 7, limit = 10): Promise<RepeatedQuestion[]> {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('messages')
    .select('content, created_at, conversations!inner(phone_number)')
    .eq('role', 'user')
    .gte('created_at', since)
    .limit(2000);
  if (error || !data) {
    console.error('[listTopQuestions] error:', error?.message);
    return [];
  }

  type Row = { content: string; created_at: string; conversations: { phone_number: string } | null };
  const buckets = new Map<string, { samples: string[]; phones: Set<string>; last: string }>();
  for (const r of data as unknown as Row[]) {
    if (!r.content || r.content.length < 6) continue;
    const key = normalizeQuestionKey(r.content);
    if (!key) continue;
    const phone = r.conversations?.phone_number ?? '';
    const b = buckets.get(key);
    if (b) {
      b.samples.push(r.content);
      if (phone) b.phones.add(phone);
      if (r.created_at > b.last) b.last = r.created_at;
    } else {
      buckets.set(key, { samples: [r.content], phones: new Set(phone ? [phone] : []), last: r.created_at });
    }
  }

  return [...buckets.entries()]
    .map(([, v]) => ({
      sample: v.samples[0].slice(0, 140),
      count: v.samples.length,
      distinct_phones: v.phones.size,
      last_seen: v.last,
    }))
    .filter((q) => q.count >= 2 || q.distinct_phones >= 2)
    .sort((a, b) => b.distinct_phones - a.distinct_phones || b.count - a.count)
    .slice(0, limit);
}
