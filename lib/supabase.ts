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
  CustomerProfileReading,
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
 * Synthetic identifier prefix used by the web-chat path to key per-session
 * state in tables that share a `phone_number` column with WhatsApp rows.
 * Anything starting with this prefix is NOT a phone number and must NOT be
 * coerced through the digit-stripping E.164 normalizer.
 */
export const WEB_SESSION_PREFIX = 'web::';

export function isWebSessionIdentifier(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith(WEB_SESSION_PREFIX);
}

/**
 * Normalize a phone number to E.164 with leading '+'. Tolerant of
 * variants like "whatsapp:+15551234567" or bare digits "15551234567".
 *
 * `web::sessionId` synthetic identifiers pass through unchanged — feeding
 * them through the digit-stripping path used to collapse every web visitor
 * onto a single bogus row (e.g. `web::abc12345` -> `+12345`) which both
 * collided across sessions AND could overwrite real customer phone rows.
 */
export function normalizePhone(raw: string): string {
  if (!raw) return raw;
  if (isWebSessionIdentifier(raw)) return raw;
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
      channel: 'whatsapp',
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
 * Get or create a conversation for a website chat session. Web rows are
 * keyed by `web_session_id` (a browser-generated UUID stored in localStorage)
 * — the conversations.phone_number column is left null until the customer
 * shares a phone number, at which point the operator can merge.
 *
 * Requires the `add-web-channel.sql` migration to be applied first
 * (adds `channel` and `web_session_id` columns).
 */
export async function getOrCreateWebConversation(
  sessionId: string,
  displayName?: string
): Promise<Conversation> {
  const supabase = createServiceClient();

  const { data: matches, error: matchErr } = await supabase
    .from('conversations')
    .select('*')
    .eq('web_session_id', sessionId)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (matchErr) {
    console.warn('[getOrCreateWebConversation] lookup error:', matchErr.message);
  }

  const existing = matches?.[0];
  if (existing) {
    if (displayName && !existing.customer_name) {
      const { data: updated } = await supabase
        .from('conversations')
        .update({ customer_name: displayName, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      return updated ?? existing;
    }
    return existing;
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      phone_number: null,
      web_session_id: sessionId,
      channel: 'web',
      customer_name: displayName ?? null,
      customer_segment: 'unknown',
      status: 'active',
      escalated: false,
    })
    .select()
    .single();

  if (error || !created) {
    throw new Error(`Failed to create web conversation: ${error?.message}`);
  }

  console.log(`[getOrCreateWebConversation] created new | session=${sessionId} | id=${created.id}`);
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
 * Optionally pass a provider message id (Meta wamid) for idempotent inserts.
 * The DB column is still named `twilio_message_sid` for historical reasons —
 * see scripts/rename-twilio-sid-column.sql for the rename migration.
 */
export async function storeMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  handoffDetected = false,
  providerMessageId?: string | null
): Promise<Message> {
  const supabase = createServiceClient();

  const payload: Record<string, unknown> = {
    conversation_id: conversationId,
    role,
    content,
    handoff_detected: handoffDetected,
  };
  if (providerMessageId) payload.twilio_message_sid = providerMessageId;

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
 * Store an INBOUND message where the insert itself is the idempotency gate.
 * A unique partial index on messages.twilio_message_sid (migration
 * 20260611_messages_wamid_unique) makes the wamid insert race-proof across
 * lambda instances: if Meta double-delivers and two instances pass the cheap
 * hasProcessedMessageSid pre-check simultaneously, exactly ONE insert wins —
 * the loser gets a unique-violation and must ack WITHOUT replying.
 * Returns { duplicate: true } in that case; any other failure still throws.
 */
export async function storeInboundMessageGate(
  conversationId: string,
  content: string,
  providerMessageId: string
): Promise<{ duplicate: boolean }> {
  const supabase = createServiceClient();
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content,
    handoff_detected: false,
    twilio_message_sid: providerMessageId,
  });

  if (error) {
    // 23505 = unique_violation → another instance already processed this wamid.
    if (error.code === '23505' || /duplicate key value/i.test(error.message)) {
      return { duplicate: true };
    }
    throw new Error(`Failed to store inbound message: ${error.message}`);
  }

  const { error: bumpErr } = await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (bumpErr) {
    console.warn(`[storeMessage] updated_at bump failed | conv=${conversationId}: ${bumpErr.message}`);
  }
  return { duplicate: false };
}

/**
 * Returns true if we've already persisted a message with this provider id
 * (Meta wamid). Used for webhook idempotency against retries.
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
 * Count how many user messages came from a given identifier in the past
 * `minutes`. Used for the rolling-hour rate cap.
 *
 * Identifier routing:
 *   • `web::sessionId` → look up by `web_session_id`. Web rows store
 *     `phone_number = NULL`, so the previous `eq('phone_number', ...)`
 *     never matched and the cap was effectively disabled for the website
 *     widget — anonymous visitors could flood Claude API with no limit.
 *   • Anything else → treat as a phone number.
 */
export async function countRecentUserMessagesFromPhone(
  phoneNumber: string,
  minutes: number
): Promise<number> {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - minutes * 60_000).toISOString();

  let convId: string | null = null;
  if (isWebSessionIdentifier(phoneNumber)) {
    const sessionId = phoneNumber.slice(WEB_SESSION_PREFIX.length);
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('web_session_id', sessionId)
      .maybeSingle();
    convId = conv?.id ?? null;
  } else {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('phone_number', phoneNumber)
      .maybeSingle();
    convId = conv?.id ?? null;
  }
  if (!convId) return 0;

  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', convId)
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
 * Sentinel reason used when the operator sends a one-off message from the
 * dashboard. The webhook recognizes this value and AUTO-DEESCALATES the next
 * time the customer replies, so Sol resumes the conversation. Any other reason
 * keeps the conversation in human-only mode until an operator manually
 * de-escalates.
 */
export const OPERATOR_REPLY_REASON = 'operator_sent_text';

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
// Image-dispatch tracking (prevents re-sending same product photo)
// ============================================================

const DISPATCHED_SKU_TTL_HOURS = 48;
const DISPATCHED_SKU_MAX = 30;

/**
 * Return the set of SKUs whose product image was sent to this conversation
 * within the TTL. Used both for server-side dedup and for prompt context.
 */
export async function getRecentDispatchedSkus(conversationId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('conversations')
    .select('recent_dispatched_skus')
    .eq('id', conversationId)
    .maybeSingle();

  if (error || !data) return [];

  const raw = (data.recent_dispatched_skus ?? []) as { sku: string; at: string }[];
  const cutoff = Date.now() - DISPATCHED_SKU_TTL_HOURS * 60 * 60 * 1000;
  return raw
    .filter((e) => e && typeof e.sku === 'string' && Date.parse(e.at) >= cutoff)
    .map((e) => e.sku.toUpperCase());
}

/**
 * Append SKUs we just dispatched to the conversation's tracking array,
 * dedupe, prune entries older than the TTL, and cap list length.
 */
export async function recordDispatchedSkus(conversationId: string, skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  const supabase = createServiceClient();

  const { data } = await supabase
    .from('conversations')
    .select('recent_dispatched_skus')
    .eq('id', conversationId)
    .maybeSingle();

  const prev = ((data?.recent_dispatched_skus ?? []) as { sku: string; at: string }[]).filter(
    (e) => e && typeof e.sku === 'string' && typeof e.at === 'string'
  );
  const now = new Date().toISOString();
  const incoming = skus.map((s) => ({ sku: s.toUpperCase(), at: now }));

  const byKey = new Map<string, { sku: string; at: string }>();
  for (const e of [...prev, ...incoming]) byKey.set(e.sku.toUpperCase(), e);

  const cutoff = Date.now() - DISPATCHED_SKU_TTL_HOURS * 60 * 60 * 1000;
  const merged = Array.from(byKey.values())
    .filter((e) => Date.parse(e.at) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, DISPATCHED_SKU_MAX);

  const { error } = await supabase
    .from('conversations')
    .update({ recent_dispatched_skus: merged, updated_at: now })
    .eq('id', conversationId);

  if (error) console.warn('[recordDispatchedSkus] update failed:', error.message);
}

// ============================================================
// Lead-quality scoring (Haiku 4.5 background job persistence)
// ============================================================

export type LeadQualityValue = 'hot' | 'warm' | 'cold' | 'dead';

export async function upsertLeadScore(
  conversationId: string,
  score: { quality: LeadQualityValue; reason: string; recommended_action: string }
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('conversations')
    .update({
      lead_quality: score.quality,
      lead_reason: score.reason,
      recommended_action: score.recommended_action,
      lead_scored_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  if (error) console.warn('[upsertLeadScore] update failed:', error.message);
}

// ============================================================
// Product helpers (used by webhook to build Sol's context)
// ============================================================

/**
 * Load the full agent_product_catalog for Sol's context window — INCLUDING
 * out-of-stock rows. OOS products used to be filtered out entirely, which made
 * Sol deny knowing a product the website still shows (honesty rule → "no está
 * en mi catálogo"). Now they're included and the formatter marks them
 * ⛔ AGOTADO so Sol can disclose, offer the closest alternative, and offer a
 * back-in-stock notification. Pay-links stay safe: lib/paylink.ts rejects any
 * SKU with in_stock=false.
 */
export async function loadAgentCatalog(): Promise<AgentProduct[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('agent_product_catalog')
    .select('*')
    .order('in_stock', { ascending: false })
    .order('category')
    .order('sell_price');

  if (error) throw new Error(`Failed to load agent catalog: ${error.message}`);

  return data ?? [];
}

/**
 * Format agent products into a concise catalog string for Sol's system prompt.
 * USA-only since 2026-05-21 — only sell_price (with discount applied if any)
 * is exposed to the agent. Cuba delivered totals are intentionally OMITTED so
 * Sol can't surface them when the customer asks, even if AGENT_PROMPT.md is
 * regressed. The cuba_shipping_fee / cuba_handling_fee columns stay in the DB
 * for historical orders + EAR §762 5-year retention, but never reach the LLM.
 * @param products Array of AgentProduct from agent_product_catalog
 */
// Categories we drop-ship from suppliers rather than keep on the shelf — the
// whole-house "fixed system" gear. When one of these is out of stock it is NOT
// a dead end: Sol can still consult and offer it as a special order (procured
// from the supplier on the customer's commitment), routed to a human for a firm
// quote (lead time + freight + deposit). Portable stations (category 'kit') are
// the stocked consumer line — their OOS stays an honest "agotado, te aviso".
const SPECIAL_ORDER_CATEGORIES = new Set(['inverter', 'battery', 'sistemas-solares-todo-en-uno']);

export function formatProductCatalogForPrompt(products: AgentProduct[]): string {
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

  const lines: string[] = [
    '=== CATÁLOGO ACTUAL DE OIIKON ===',
    'Cada producto muestra el precio en EE.UU. (sell_price con descuento aplicado si hay) y el descuento activo si aplica. Oiikon envía únicamente dentro de los 48 estados continentales — no muestres precios ni envíos internacionales.',
  ];

  for (const [cat, prods] of Object.entries(grouped)) {
    lines.push(`\n${categoryNames[cat] ?? cat.toUpperCase()}`);
    for (const p of prods) {
      const specs: string[] = [];

      if (p.battery_capacity_wh) specs.push(`${p.battery_capacity_wh.toLocaleString()}Wh`);
      if (p.battery_capacity_ah) specs.push(`${p.battery_capacity_ah}Ah`);
      if (p.battery_voltage) specs.push(`${p.battery_voltage}V`);
      if (p.inverter_watts) specs.push(`${p.inverter_watts.toLocaleString()}W inversor`);
      if (p.output_watts && p.category === 'kit') specs.push(`${p.output_watts.toLocaleString()}W salida`);
      if (p.peak_watts) specs.push(`${p.peak_watts.toLocaleString()}W pico`);
      if (p.panel_watts) specs.push(`${p.panel_watts}W panel`);
      if (p.solar_input_watts) specs.push(`${p.solar_input_watts.toLocaleString()}W solar`);
      // Weight — customers ask this often (portability, can an older relative
      // carry it, shipping). Data is 100% populated in agent_product_catalog.
      if (p.weight_lbs) specs.push(`${p.weight_lbs} lb`);
      if (p.supports_external_battery) specs.push('expandible con batería externa');

      const specsStr = specs.length ? ` (${specs.join(', ')})` : '';

      // Defense-in-depth: even though /api/cron/sync-inventory has its own
      // spike guard, a direct DB write or a bug upstream could still land a
      // bogus discount on the catalog. We clamp to [0, 50] at the moment of
      // formatting the prompt so Sol can never quote a price below half sell_price.
      // Anything above 50 is a signal of data corruption — we log loudly and
      // show the product at 50% off rather than giving it away.
      const rawDiscount = p.discount_percentage ?? 0;
      const discount = Math.max(0, Math.min(50, rawDiscount));
      if (rawDiscount !== discount) {
        console.warn(
          `[formatProductCatalogForPrompt] discount clamped for SKU ${p.sku}: ` +
            `${rawDiscount}% -> ${discount}% (check agent_product_catalog + inventory sync log)`
        );
      }
      const effectiveUsa = discount > 0 ? p.sell_price * (1 - discount / 100) : p.sell_price;

      // USA-only catalog: never expose Cuba delivered totals to the agent.
      // p.cuba_shipping_fee / p.cuba_handling_fee remain in the DB for
      // historical-order math + EAR §762 retention, but Sol's prompt only
      // ever sees the US sell_price.
      // Discount badge — computed from the MSRP anchor (original_price) vs the
      // effective price, NOT from discount_percentage. This survives a catalog→
      // storefront price sync where sell_price is the real price and
      // discount_percentage=0 but original_price still holds the MSRP (e.g.
      // E2000LFP $599 vs MSRP $1,499 = 60% off — the storefront's hook). The
      // PRICE shown is always effectiveUsa, so this DISPLAY math can never cause
      // a giveaway; cap the shown % at 80 as a sanity guard against a bogus MSRP.
      const msrp = p.original_price ?? 0;
      const showStrike = msrp > effectiveUsa + 0.01;
      const badgePct = showStrike
        ? Math.min(80, Math.round((1 - effectiveUsa / msrp) * 100))
        : 0;
      const priceParts: string[] = [`SKU ${p.sku}`, `Precio $${effectiveUsa.toFixed(2)} (envío gratis en EE.UU.)`];
      if (showStrike) {
        priceParts.push(`(antes $${msrp.toFixed(2)}, ${badgePct}% descuento)`);
      }

      const oosTag = p.in_stock
        ? ''
        : SPECIAL_ORDER_CATEGORIES.has(p.category)
          ? ' 🔧 POR ENCARGO (no en stock) — puedes asesorarlo y dimensionarlo con normalidad; es un pedido especial que traemos del proveedor. NO des link de pago ni prometas fecha exacta de entrega. Captura la necesidad (carga, ciudad, uso) y escala con [HANDOFF: pedido por encargo — SKU + necesidad] para que el especialista cotice (tiempo + flete) y gestione el anticipo.'
          : ' ⛔ AGOTADO TEMPORALMENTE — no lo vendas ni des link de pago; informa con honestidad, ofrece la alternativa en stock más cercana y pregunta si quiere que le avisemos cuando regrese';
      lines.push(`• ${p.name}${specsStr}: ${priceParts.join(' · ')}${oosTag}`);
      if (p.ideal_for) lines.push(`  Ideal para: ${p.ideal_for}`);
      // Real expansion/compatibility pairings (source: pecron.com) so Sol names
      // the correct battery instead of guessing. Only present when populated.
      if (p.compatible_with && p.compatible_with.trim()) {
        lines.push(`  Compatible con: ${p.compatible_with.trim()}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * A presentable promo from the shared `discount_codes` table. Sol never
 * picks among these herself — the server computes the single best margin-safe
 * offer per SKU (see `selectBestOffer`) and injects only that one, so the LLM
 * never sees cost data and can't over-promise a code checkout would reject.
 */
export interface Offer {
  code: string;
  description: string | null;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  min_order_total: number | null;
  max_discount: number | null;
  eligible_brand: string | null;
  min_margin_pct: number | null;
  valid_until: string | null;
}

// Codes Sol may auto-present in organic chat. Public, non-segment only:
// excludes diaspora-targeted (FAMILIA*) and paid-traffic vanity codes
// (EARLYBUYER15), and the high-floor OFERTA15 (20% floor fails margin on
// virtually every PECRON SKU). Override without a deploy via the
// SOL_PRESENTABLE_COUPONS env (comma-separated list of codes).
const DEFAULT_PRESENTABLE_COUPONS = [
  // SUMMER100 replaced the expired MEMORIAL100 (discount_codes description,
  // 2026-06-06) — same $100-off-PECRON role for the hurricane-prep season.
  'SUMMER100', 'PECRON7', 'E3600SAVE', 'E3800SAVE50', 'FAMILIA_F5000',
  'WELCOME50', 'BIENVENIDO10', 'SAVE5', 'HURRICANE5',
];

function presentableCouponCodes(): string[] {
  const env = (process.env.SOL_PRESENTABLE_COUPONS ?? '').trim();
  if (!env) return DEFAULT_PRESENTABLE_COUPONS;
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Load the active, in-window, presentable coupons from the shared table.
 * Returns [] when none — Sol then quotes plain catalog prices with no nudge.
 */
export async function loadActiveOffers(): Promise<Offer[]> {
  const codes = presentableCouponCodes();
  if (codes.length === 0) return [];
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('discount_codes')
    .select('code, description, discount_type, discount_value, min_order_total, max_discount, eligible_brand, min_margin_pct, valid_until')
    .eq('is_active', true)
    .in('code', codes);
  if (error || !data) return [];
  const now = Date.now();
  return (data as Offer[]).filter(
    (o) => !o.valid_until || new Date(o.valid_until).getTime() >= now,
  );
}

/**
 * Map of lower-cased SKU → wholesale cost, read from the Oiikon-owned
 * `products` table. Used ONLY server-side to gate offers on margin; cost is
 * never placed in Sol's prompt. Missing rows just omit the SKU.
 */
export async function loadProductCosts(): Promise<Record<string, number>> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('products').select('sku, cost_price');
  if (error || !data) return {};
  const map: Record<string, number> = {};
  for (const row of data as { sku: string | null; cost_price: number | null }[]) {
    if (row.sku && row.cost_price != null) {
      map[row.sku.toLowerCase()] = Number(row.cost_price);
    }
  }
  return map;
}

export interface StorefrontProduct {
  sku: string;
  name: string;
  brand: string | null;
  sell_price: number;
  discount_percentage: number | null;
  in_stock: boolean;
}

/**
 * Pay-link fallback: load specific SKUs from the storefront `products` table
 * (the full oiikon.com catalog). Used ONLY for SKUs NOT present in the curated
 * agent_product_catalog, so Sol can pay-link any active, in-stock, publicly
 * visible website product (e.g. accessories). This is a READ — it never writes
 * a price; agent_product_catalog stays the source of truth for items it holds,
 * preserving the intentional price difference between the two tables.
 */
export async function loadStorefrontProductsBySku(skus: string[]): Promise<StorefrontProduct[]> {
  const clean = Array.from(new Set(skus.map((s) => (s || '').trim()).filter(Boolean)));
  if (!clean.length) return [];
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('products')
    .select('sku, name, name_paypal, brand, sell_price, price, discount_percentage, in_stock, is_active, is_publicly_visible')
    .in('sku', clean)
    .eq('is_active', true)
    .eq('in_stock', true);
  if (error || !data) {
    if (error) console.warn('[loadStorefrontProductsBySku]', error.message);
    return [];
  }
  const out: StorefrontProduct[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (r.is_publicly_visible === false) continue; // never pay-link hidden products
    // In `products`, `sell_price` is the marketing ANCHOR and
    // `discount_percentage` is the anchor→real conversion: sell × (1−disc)
    // equals `price`, the REAL charged price (verified 2026-06-10 — the
    // identity holds on every row, e.g. E1500LFP $1,299 × (1−63.9%) = $469).
    // Return the REAL price with discount 0. Passing the raw anchor+discount
    // through hit buildPayLink's 0-50% corruption clamp, silently OVERCHARGING
    // any fallback SKU whose anchor-discount exceeds 50% (e.g. BUNDLE-HR3600:
    // 57.7% → clamped to 50% → $1,499 charged vs $1,268 real).
    const direct = Number((r.price as number) ?? 0);
    const anchor = Number((r.sell_price as number) ?? 0);
    const disc = Number((r.discount_percentage as number) ?? 0);
    const real =
      direct > 0
        ? direct
        : anchor > 0
          ? Math.round(anchor * (1 - Math.max(0, Math.min(100, disc)) / 100) * 100) / 100
          : 0;
    if (!(real > 0)) continue;
    out.push({
      sku: String(r.sku),
      name: String((r.name_paypal as string) || (r.name as string) || r.sku),
      brand: (r.brand as string) ?? null,
      sell_price: real,
      discount_percentage: 0,
      in_stock: Boolean(r.in_stock),
    });
  }
  return out;
}

/**
 * Overlay LIVE storefront prices onto catalog rows. READ-ONLY — never writes a
 * price column (the two tables differ on purpose; we only READ `products` to
 * show the current price). For each row, replaces `sell_price` with the live
 * net = storefront `sell_price` (anchor) × (1 − discount%), keeping the anchor
 * as `original_price` and the live `discount_percentage`. Rows with no live
 * match keep their catalog price. Single source of truth so the dashboard
 * picker, pay-link panel, and marketing posts all quote the SAME live price.
 */
export async function applyLivePricing<
  T extends { sku: string; sell_price?: number | null; original_price?: number | null; discount_percentage?: number | null },
>(rows: T[], opts: { dropOutOfStock?: boolean } = {}): Promise<T[]> {
  if (!rows.length) return rows;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('products')
    .select('sku, sell_price, discount_percentage, in_stock')
    .in('sku', rows.map((r) => r.sku));
  const bySku = new Map<string, { sell_price: number | null; discount_percentage: number | null; in_stock: boolean | null }>();
  for (const r of data ?? []) {
    bySku.set(String((r as { sku: string }).sku).toUpperCase(), r as { sell_price: number | null; discount_percentage: number | null; in_stock: boolean | null });
  }
  const out: T[] = [];
  for (const r of rows) {
    const live = bySku.get(r.sku.toUpperCase());
    if (opts.dropOutOfStock && live && live.in_stock === false) continue;
    const anchor = live ? Number(live.sell_price ?? 0) : 0;
    if (live && anchor > 0) {
      const disc = Number(live.discount_percentage ?? 0);
      const net = Math.round(anchor * (1 - disc / 100) * 100) / 100;
      out.push({ ...r, sell_price: net, original_price: anchor, discount_percentage: disc });
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Upload a generated marketing image (e.g. a composited product ad) to the
 * shared public Storage bucket and return its public URL — so previews + Meta
 * publishing have a stable hosted URL. Returns null on failure (caller falls
 * back to the stock product photo).
 */
export async function uploadMarketingImage(
  name: string,
  buf: Buffer,
  contentType = 'image/jpeg',
): Promise<string | null> {
  const supabase = createServiceClient();
  const bucket = process.env.MARKETING_IMAGE_BUCKET || 'media-content';
  const key = `marketing-composites/${name}`;
  const { error } = await supabase.storage.from(bucket).upload(key, buf, { contentType, upsert: true });
  if (error) {
    console.warn('[uploadMarketingImage]', error.message);
    return null;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(key);
  return data?.publicUrl ?? null;
}

export interface SelectedOffer {
  code: string;
  /** Dollars off the effective (post product-discount) price. */
  savings: number;
  /** Price after applying this coupon. */
  finalPrice: number;
  /** Human label, e.g. "7% de descuento" or "$100 de descuento". */
  label: string;
}

/**
 * Pick the single best margin-safe offer for ONE product, or null if none
 * qualifies. "Best" = largest customer savings among offers that:
 *  - match brand (eligible_brand null = any brand, else case-insensitive ==)
 *  - effectivePrice >= min_order_total
 *  - leave gross margin (finalPrice - cost) / finalPrice >= min_margin_pct
 *
 * Gross-margin formula validated 2026-05-28 against the MEMORIAL20
 * deactivation: 20% off drops E3800LFP from 19.9% to -0.1% margin, matching
 * the operator note "20% kills margin on all PECRON SKUs". When cost is
 * unknown we cannot verify the floor, so we conservatively skip any
 * floor-bearing offer rather than quote one checkout might reject.
 *
 * Pure function — exported for unit testing.
 */
export function selectBestOffer(
  effectivePrice: number,
  brand: string | null,
  cost: number | null,
  offers: Offer[],
): SelectedOffer | null {
  let best: SelectedOffer | null = null;

  for (const o of offers) {
    // Null-safe: a catalog/accessory row may have no brand. A null brand can
    // only match brand-agnostic offers (eligible_brand null), never a
    // brand-specific one — and must never throw (a null brand once 500'd Sol's
    // entire AI path for all conversations).
    if (o.eligible_brand && o.eligible_brand.toLowerCase() !== (brand ?? '').toLowerCase()) continue;
    if (o.min_order_total != null && effectivePrice < Number(o.min_order_total)) continue;

    let savings =
      o.discount_type === 'percentage'
        ? effectivePrice * (Number(o.discount_value) / 100)
        : Number(o.discount_value);
    if (o.max_discount != null) savings = Math.min(savings, Number(o.max_discount));
    if (savings <= 0) continue;

    const finalPrice = effectivePrice - savings;

    if (o.min_margin_pct != null) {
      if (cost == null) continue; // can't verify floor → don't risk it
      const margin = finalPrice > 0 ? ((finalPrice - cost) / finalPrice) * 100 : -Infinity;
      if (margin < Number(o.min_margin_pct)) continue;
    }

    if (!best || savings > best.savings) {
      best = {
        code: o.code,
        savings: Math.round(savings * 100) / 100,
        finalPrice: Math.round(finalPrice * 100) / 100,
        label:
          o.discount_type === 'percentage'
            ? `${Number(o.discount_value)}% de descuento`
            : `$${Number(o.discount_value).toFixed(0)} de descuento`,
      };
    }
  }

  return best;
}

/**
 * Build the per-SKU "best offer" block appended to Sol's catalog context.
 * For each in-stock product we compute the single best margin-safe offer and
 * list ONLY that one. Sol is told to present exactly the listed code per
 * equipment — one per equipment, never multiple for the same item, never
 * invented — though for a multi-item pay-link combo she passes each item's
 * own code comma-separated in a single [[PAYLINK]] marker. Returns
 * '' when no product has any applicable offer (prompt unchanged).
 */
export function formatOffersForPrompt(
  products: AgentProduct[],
  offers: Offer[],
  costBySku: Record<string, number>,
): string {
  if (offers.length === 0) return '';

  const lines: string[] = [];
  for (const p of products) {
    if (!p.in_stock) continue;
    const discount = Math.max(0, Math.min(50, p.discount_percentage ?? 0));
    const effective = discount > 0 ? p.sell_price * (1 - discount / 100) : p.sell_price;
    const cost = costBySku[p.sku.toLowerCase()] ?? null;
    const best = selectBestOffer(effective, p.brand, cost, offers);
    if (best) {
      // Anchor the presentation to the MSRP (original_price), NOT the sell_price.
      // Otherwise a coupon on a 56%-off-MSRP unit reads as a puny "$50 off" — Sol
      // showed exactly that to a comparison shopper (Maddog, E3600 $949 framed as
      // "$50 off ~$1,049" instead of "59% off ~$2,299"). When a real MSRP anchor
      // exists (> final), give Sol the strike price + TOTAL % off the customer is
      // getting, coupon folded in. No MSRP → fall back to coupon-only framing.
      const msrp = p.original_price ?? 0;
      const showAnchor = msrp > best.finalPrice + 0.01;
      if (showAnchor) {
        const totalPct = Math.min(80, Math.round((1 - best.finalPrice / msrp) * 100));
        const totalSavings = Math.round((msrp - best.finalPrice) * 100) / 100;
        lines.push(
          `• ${p.sku}: código *${best.code}* → presenta ~$${msrp.toFixed(2)}~ *$${best.finalPrice.toFixed(2)}* (${totalPct}% de descuento, YA incluye el código) · ahorro total ~$${totalSavings.toFixed(2)} · link con ?promo=${best.code}`,
        );
      } else {
        lines.push(
          `• ${p.sku}: código *${best.code}* — ${best.label} (ahorra ~$${best.savings.toFixed(2)}, queda ~$${best.finalPrice.toFixed(2)}) · link con ?promo=${best.code}`,
        );
      }
    }
  }
  if (lines.length === 0) return '';

  return [
    '',
    '=== MEJOR OFERTA POR EQUIPO (una sola, ya validada por margen) ===',
    'Para cada SKU de abajo ya calculamos LA única oferta aplicable (filtrada por marca, pedido mínimo y margen). Es la ÚNICA que puedes presentar para ese equipo.',
    ...lines,
    '',
    'Reglas de oferta (OBLIGATORIAS):',
    '• AL RECOMENDAR EN FIRME o dar el precio de un equipo que SÍ aparece arriba, presenta SIEMPRE el precio CON su oferta usando EXACTAMENTE el ancla y los números de la línea de arriba: ~precio de LISTA tachado~ *precio final* + el % TOTAL de descuento + código + link con ?promo=. ANCLA AL PRECIO DE LISTA (el ~$X~ de arriba), NUNCA al precio neto: un equipo que ya está 56% por debajo de lista NO se presenta como "$50 de descuento" — eso entierra la oferta real y regala la venta a un cliente que compara (pasó en producción: el E3600 a $949 se mostró como "$50 off ~$1,049" en vez de "59% off ~$2,299"). Tampoco des el precio "limpio" sin el cupón cuando existe (un lead del F5000 recibió $1,999 plano teniendo $100 vigentes).',
    '• UN código por equipo: para CADA equipo presenta SOLO su código listado arriba. NUNCA le ofrezcas a un mismo equipo varios cupones, ni inventes códigos, ni le pongas a un equipo el cupón de otro.',
    '• COMBO (varios equipos en un mismo pago por link): en la etiqueta [[PAYLINK ... coupon=A,B]] incluye el código de CADA equipo separados por coma —el mismo que cotizaste para cada uno—. El sistema aplica a cada equipo el mejor cupón seguro de esa lista, así ninguno queda a precio completo. Esto NO contradice la regla anterior: sigue siendo UN código por equipo, solo combinados en una misma etiqueta.',
    '• Si un equipo NO aparece en esta lista, no tiene oferta aplicable — cotiza el precio normal del catálogo, sin cupón.',
    '• Aunque la pregunta no sea de precio (garantía, specs, compatibilidad), responde primero lo que preguntó y luego añade UNA línea con la oferta del equipo.',
    '• El descuento se aplica en el checkout de oiikon.com (tú no lo aplicas). Presenta el ahorro como aproximado: "con el código *CÓDIGO* ahorras alrededor de $X".',
    '• LINK CON CUPÓN AUTO-APLICADO (OBLIGATORIO cuando hay oferta): cuando presentes la oferta de un equipo, envía el link del producto CON el cupón ya incluido como `?promo=CÓDIGO` al final, p. ej. `https://oiikon.com/product/<slug>?promo=E3600SAVE`. Así el cliente toca el link → el descuento ya queda aplicado en el checkout, sin que él escriba el código. Usa el slug correcto del producto (el del catálogo) + `?promo=` + el código exacto de la oferta. Si NO hay oferta para ese equipo, envía el link normal sin `?promo=`.',
    '',
  ].join('\n');
}

/**
 * Resolve a product image URL by SKU (case-insensitive).
 * Tries `primary_image_url` → first usable `gallery_images` entry → legacy
 * `image_url` column (which is what oiikon.com itself renders for older
 * products whose primary/gallery were never populated).
 * Unsplash placeholders are skipped. Returns null if nothing usable.
 *
 * WhatsApp media expects JPEG/PNG — our storage bucket is 100% webp, so any
 * webp URL is proxied through wsrv.nl which transcodes to JPEG on the fly.
 * Without this the `sendImage` call 400s and the customer gets nothing.
 */
/**
 * Resolve a click-to-WhatsApp ad URL (e.g.
 * "https://oiikon.com/product/pecron-e3600lfp") to a catalog SKU + name, so Sol
 * can open the conversation referencing the exact product the customer clicked.
 * Matches on the products slug; falls back to scanning the URL for a known SKU.
 * Returns null when nothing matches (Sol then uses the generic ad opener).
 */
/**
 * Patch a small set of safe scalar fields on a conversation row. Used to seed
 * product_interest from the click-to-WhatsApp ad referral. Best-effort.
 */
export async function updateConversationFields(
  conversationId: string,
  patch: { product_interest?: string | null; ad_source?: string | null; ctwa_clid?: string | null },
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from('conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

export async function resolveProductFromUrl(
  url: string | null | undefined,
): Promise<{ sku: string; name: string } | null> {
  if (!url || typeof url !== 'string') return null;
  const lower = url.toLowerCase();
  const supabase = createServiceClient();

  // 1) Try slug match (the last path segment of /product/<slug>).
  const seg = lower.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? '';
  if (seg) {
    const { data } = await supabase
      .from('products')
      .select('sku, name, slug, url_slug')
      .or(`slug.eq.${seg},url_slug.eq.${seg}`)
      .limit(1)
      .maybeSingle();
    if (data?.sku) return { sku: data.sku, name: (data as any).name ?? data.sku };
  }

  // 2) Fallback: scan the URL for any in-stock SKU token (slugs embed the SKU,
  //    e.g. ".../pecron-e3600lfp" contains "e3600lfp").
  const { data: rows } = await supabase
    .from('agent_product_catalog')
    .select('sku, name')
    .eq('in_stock', true);
  for (const r of rows ?? []) {
    const sku = String((r as any).sku ?? '').toLowerCase();
    if (sku && sku.length >= 4 && lower.includes(sku)) {
      return { sku: (r as any).sku, name: (r as any).name ?? (r as any).sku };
    }
  }
  return null;
}

/**
 * Operator-maintained ad URL → product map (`ad_url_map` table). Authoritative
 * for a known ad: Ed declares "this fb.me/IG link sells the F5000" when he
 * launches it, so even the FIRST headline-less lead resolves correctly. Checked
 * before the history heuristic. Returns null if the URL isn't mapped/active.
 */
export async function resolveAdProductFromMap(
  sourceUrl: string | null | undefined,
): Promise<{ name: string; sku: string | null } | null> {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('ad_url_map')
    .select('sku, product_name')
    .eq('ad_url', sourceUrl)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  const row = data as { sku?: string | null; product_name?: string | null } | null;
  if (!row || (!row.sku && !row.product_name)) return null;
  return { name: (row.product_name ?? row.sku) as string, sku: row.sku ?? null };
}

/**
 * Recover the ad's product when Meta's CTWA referral arrives with only a
 * source URL and NO headline (rare — ~1 in 40 ad leads). The SAME ad short-link
 * (e.g. fb.me/6LqKWPscm) almost always arrived WITH the product name on other
 * leads, so we look it up in our own `conversations.ad_source` history:
 *   "ad | PECRON F5000LFP… | https://fb.me/6LqKWPscm"
 * Returns the product name + extracted model SKU, or null if this URL was never
 * seen with a product. Best-effort; only called on the headline-less path.
 */
export async function resolveAdProductFromUrlHistory(
  sourceUrl: string | null | undefined,
): Promise<{ name: string; sku: string | null } | null> {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('conversations')
    .select('ad_source')
    .ilike('ad_source', `%${sourceUrl}%`)
    .like('ad_source', '% | %') // only rows that carry a product name
    .order('created_at', { ascending: false })
    .limit(1);
  const adSource = ((data ?? [])[0] as { ad_source?: string } | undefined)?.ad_source;
  if (!adSource) return null;
  const name = adSource.split(' | ')[1]?.trim();
  if (!name) return null;
  const sku = name.match(/\b([EF]\d{3,4}[A-Z]{0,5})\b/)?.[1]?.toUpperCase() ?? null;
  return { name, sku };
}

export async function getProductImages(sku: string, max = 2): Promise<string[]> {
  if (!sku?.trim() || max <= 0) return [];

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('products')
    .select('primary_image_url, gallery_images, image_url')
    .ilike('sku', sku.trim())
    .limit(1)
    .maybeSingle();

  if (error || !data) return [];

  const isUsable = (u: unknown): u is string =>
    typeof u === 'string' && u.startsWith('https://') && !u.includes('images.unsplash.com');

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown) => {
    if (isUsable(u) && !seen.has(u)) {
      seen.add(u);
      ordered.push(u);
    }
  };

  push(data.primary_image_url);
  if (Array.isArray(data.gallery_images)) {
    for (const u of data.gallery_images) push(u);
  }
  push(data.image_url);

  return ordered.slice(0, max).map(toWhatsAppMediaUrl);
}

/**
 * WhatsApp media is most reliable as JPEG/PNG. Wrap webp URLs in the free
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

  // Filter by is_active so soft-disabled entries (e.g. Cuba-specific QA
  // pairs marked inactive on 2026-05-21 when Oiikon went USA-only) never
  // reach Sol's runtime context. The rows remain in the table for audit
  // history; flip is_active back to true to re-enable.
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .eq('is_active', true)
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
    /** Structured behavioral read. Pass the already-merged object (the caller
     *  is responsible for running mergeReading() so the "null preserves
     *  existing" rule is applied). An empty object {} clears nothing — to
     *  actually blank the column use {reading: null}. */
    reading?: CustomerProfileReading | null;
    /** IANA timezone for quiet-hours enforcement on outbound crons. */
    user_timezone?: string | null;
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
  if (patch.reading !== undefined) payload.reading = patch.reading;
  if (patch.user_timezone !== undefined) payload.user_timezone = patch.user_timezone;

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

  // Structured read — only rendered when we have at least one populated
  // dimension. The guidance per value is what makes this useful to Sol:
  // raw enum values would just be jargon; the imperative sentence tells her
  // *how* to adapt the next turn.
  const readBlock = formatReadingForPrompt(profile.reading ?? null);
  if (readBlock) lines.push(readBlock);

  if (lines.length === 2) return '';
  return lines.join('\n');
}

/**
 * Render the structured behavioral read as a prompt block. Only populated
 * dimensions appear — a freshly-seeded row with just `arrival_source` still
 * produces a useful two-line block. Returns empty string when nothing is
 * populated so the caller can skip it entirely.
 *
 * The per-dimension advice is deliberately prescriptive (imperative verbs) and
 * kept to one line each so the block stays compact. This is INTERNAL guidance
 * for Sol's tone/content — the header makes that explicit so the model doesn't
 * echo these labels back to the customer.
 */
export function formatReadingForPrompt(reading: CustomerProfileReading | null): string {
  if (!reading) return '';

  const rows: string[] = [];

  if (reading.intent_stage) {
    const hint: Record<string, string> = {
      explorando: 'aún no ha dicho qué necesita → haz UNA pregunta que califique (Cuba vs aquí, uso principal).',
      evaluando: 'está comparando → diferencia con $/Wh, garantía y entrega, no repitas catálogo.',
      listo_comprar: 'pidió link/pago/envío → cierra: dale enlace directo al producto acordado, no re-vendas.',
      post_venta: 'ya compró → responde como soporte, no ofrezcas más productos sin señal.',
    };
    rows.push(`• Etapa: ${reading.intent_stage} — ${hint[reading.intent_stage] ?? ''}`.trim());
  }

  if (reading.knowledge_level) {
    const hint: Record<string, string> = {
      novato: 'usa lenguaje sencillo; evita LFP/MPPT/Wh sin analogía ("aguanta como X bombillos por Y horas").',
      intermedio: 'puedes usar términos técnicos con una frase de contexto; no asumas experto.',
      experto: 'usa vocabulario técnico directo (LFP, MPPT, ciclos, voltaje); cero explicaciones básicas.',
    };
    rows.push(`• Nivel técnico: ${reading.knowledge_level} — ${hint[reading.knowledge_level] ?? ''}`.trim());
  }

  if (reading.price_sensitivity) {
    const hint: Record<string, string> = {
      alta: 'precio manda — lidera con descuentos, $/Wh, ofertas activas antes que specs.',
      media: 'precio pesa pero no bloquea — equilibra valor y precio.',
      baja: 'pagará por lo correcto — lidera con calidad, garantía, ajuste a su necesidad.',
    };
    rows.push(`• Sensibilidad a precio: ${reading.price_sensitivity} — ${hint[reading.price_sensitivity] ?? ''}`.trim());
  }

  if (reading.urgency) {
    const hint: Record<string, string> = {
      ya: 'necesidad inmediata (apagón en curso) → velocidad de respuesta y entrega rápida mandan.',
      semanas: 'compra a semanas — cerrar con link y plan de envío ahora tiene sentido.',
      meses: 'planifica con tiempo — no presiones cierre; siembra beneficios clave y déjale el material.',
      sin_prisa: 'explorando — educativo, no presiones; pide qué lo detiene para ayudar mejor.',
    };
    rows.push(`• Urgencia: ${reading.urgency} — ${hint[reading.urgency] ?? ''}`.trim());
  }

  if (Array.isArray(reading.objection_themes) && reading.objection_themes.length > 0) {
    rows.push(
      `• Objeciones vistas: ${reading.objection_themes.join(', ')} — adelántate y abórdalas sin que las repita.`
    );
  }

  if (reading.arrival_source) {
    const src = reading.arrival_source;
    const hint = src.startsWith('facebook_ad:')
      ? 'llegó por anuncio de Facebook → recién conoce Oiikon; preséntate breve, no asumas contexto.'
      : src === 'organic'
      ? 'llegó orgánicamente → quizás ya conoce Oiikon; sigue su lead.'
      : '';
    rows.push(`• Origen: ${src}${hint ? ' — ' + hint : ''}`);
  }

  if (rows.length === 0) return '';

  return [
    '\n=== CÓMO LEER A ESTE CLIENTE (guía interna — NO se la muestres) ===',
    ...rows,
  ].join('\n');
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
    { count: conversions },
    { data: deepData },
  ] = await Promise.all([
    supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('created_at', since),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', since),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('role', 'assistant').gte('created_at', since),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('escalated', true).gte('updated_at', since),
    // Conversions are counted by converted_at (operator-confirmed), not
    // updated_at, so a conversion that happens this week counts this week
    // even if the conversation started months ago.
    supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('converted_at', since),
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
    conversions: conversions ?? 0,
  };
}

/**
 * Mark a conversation as a closed/won sale. Sets converted_at=now() and
 * also sets status='closed' so it drops out of the active-work list.
 *
 * This is operator-only — never called from the Claude response path.
 * The counter it feeds (OverviewMetrics.conversions) is only trustworthy
 * if it reflects ground truth, not model inference.
 *
 * Idempotent: repeated calls re-stamp converted_at without creating
 * duplicate rows or log entries. If the operator needs to *undo* a won
 * mark, do it via Supabase console (deliberately friction-heavy — losing
 * a conversion shouldn't be a one-command operation).
 */
export async function markConversationWon(conversationId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('conversations')
    .update({
      converted_at: new Date().toISOString(),
      status: 'closed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) {
    console.error('[markConversationWon] error:', error.message);
    throw error;
  }
}

/**
 * Resolve a phone number (raw, as typed by the operator) to the conversation
 * row. Used by the /won <phone> command so the operator can close a sale
 * without having to copy a UUID.
 *
 * Tries a direct match first, then falls back to the normalized (digits-only)
 * lookup. Returns null if no match — the caller should surface a helpful
 * error to the operator.
 */
export async function getConversationByAnyPhone(rawPhone: string): Promise<Conversation | null> {
  // Try the exact stored phone first (saves a normalize call on the hot path)
  const direct = await getConversationByPhone(rawPhone);
  if (direct) return direct;
  // Fall through to digits-only match for operator convenience
  const digitsOnly = rawPhone.replace(/\D/g, '');
  if (!digitsOnly || digitsOnly === rawPhone) return null;
  return getConversationByPhone(digitsOnly);
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
