// ============================================================
// Oiikon WhatsApp Agent — TypeScript Types
// ============================================================

export type CustomerSegment = 'cuban_family' | 'general' | 'unknown';
export type ConversationStatus = 'active' | 'escalated' | 'closed';
export type MessageRole = 'user' | 'assistant' | 'system';
export type ProductCategory =
  | 'portable_station'
  | 'battery'
  | 'inverter'
  | 'panel'
  | 'all_in_one'
  | 'accessory';

// ── Database row types ──────────────────────────────────────

export interface DispatchedImage {
  sku: string;
  at: string;
}

export type LeadQuality = 'hot' | 'warm' | 'cold' | 'dead';

export interface Conversation {
  id: string;
  phone_number: string;
  customer_name: string | null;
  customer_segment: CustomerSegment;
  status: ConversationStatus;
  escalated: boolean;
  escalation_reason: string | null;
  product_interest: string | null;
  opted_out: boolean;
  opted_out_at: string | null;
  recent_dispatched_skus: DispatchedImage[];
  lead_quality: LeadQuality | null;
  lead_reason: string | null;
  recommended_action: string | null;
  lead_scored_at: string | null;
  /** When the operator confirmed this conversation led to a sale.
   *  NULL = not converted. Set via /won <phone> or dashboard button. */
  converted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  handoff_detected: boolean;
  created_at: string;
}

// ── DEPRECATED: Use AgentProduct instead ──────────────────
// Kept for backward compatibility with existing code
export interface Product {
  id: string;
  sku: string;
  name: string;
  category: ProductCategory;
  brand: string;
  capacity_wh: number | null;
  output_watts: number | null;
  price_usd: number;
  price_includes_cuba_shipping: boolean;
  in_stock?: boolean;
  description_es: string | null;
  ideal_for: string | null;
  created_at: string;
  updated_at: string;
}

// ── Agent Product (from agent_product_catalog table) ──────
// This is the new interface for the WhatsApp agent catalog
export interface AgentProduct {
  id: string;
  product_id: string | null;
  sku: string;
  name: string;
  category: string;
  brand: string;
  sell_price: number;
  cuba_shipping_fee: number;
  cuba_handling_fee: number;
  cuba_total_price: number; // GENERATED: sell_price + cuba_shipping_fee + cuba_handling_fee
  usa_shipping_fee: number;
  battery_capacity_ah: number | null;
  battery_capacity_wh: number | null;
  battery_voltage: number | null;
  battery_type: string | null;
  inverter_watts: number | null;
  inverter_type: string | null;
  mppt_channels: number | null;
  solar_input_watts: number | null;
  panel_watts: number | null;
  panel_type: string | null;
  output_watts: number | null;
  peak_watts: number | null;
  weight_lbs: number;
  in_stock: boolean;
  stock_quantity: number;
  description_short: string | null;
  ideal_for: string | null;
  compatible_with: string | null;
  supports_external_battery: boolean;
  original_price: number | null;
  discount_percentage: number;
  /** Set when an operator edits this row from the dashboard. The cron sync
   * (/api/cron/sync-inventory) skips rows whose override is younger than
   * INVENTORY_SYNC_OVERRIDE_TTL_HOURS so the deliberate change isn't reverted. */
  manually_overridden_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ── Competitor models (other brands Sol pivots away from) ──
// Sol uses these to do a respectful $/Wh comparison when a customer
// mentions EcoFlow / Jackery / Bluetti / Anker / Goal Zero. Editable
// from /dashboard/competitors. Auto-refreshed weekly by
// /api/cron/refresh-competitors unless manually_overridden_at is recent.
export interface CompetitorModel {
  id: string;
  brand: string;
  model: string;
  capacity_wh: number;
  inverter_watts: number | null;
  current_price_usd: number;
  chemistry: 'LFP' | 'NMC' | string | null;
  warranty_years: number | null;
  source_url: string | null;
  active: boolean;
  notes: string | null;
  manually_overridden_at: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Customer profile (auto-learned per contact) ─────────────
export interface CustomerProfileFact {
  fact: string;
  source_msg_id: string | null;
  verified_at: string;
}

/**
 * Structured behavioral read of the customer, used to adapt Sol's tone and
 * content in real time. All fields are optional — the Haiku extractor emits
 * only what it has signal on, and the merge rule is "new value wins, null
 * preserves existing". That way a later turn can't downgrade a confident
 * earlier read by emitting null.
 *
 * This is the v1 schema: intent_stage / knowledge_level / price_sensitivity /
 * urgency / objection_themes / arrival_source. The column is JSONB so future
 * dimensions can be added without a migration.
 */
export interface CustomerProfileReading {
  /** Funnel position. explorando = just clicked, hasn't said what they need.
   *  evaluando = comparing options. listo_comprar = asked for link / payment /
   *  shipping. post_venta = already bought, still chatting. */
  intent_stage?: 'explorando' | 'evaluando' | 'listo_comprar' | 'post_venta' | null;
  /** Technical vocabulary proficiency. Drives whether Sol uses LFP/MPPT/Wh or
   *  plain-language analogies. */
  knowledge_level?: 'novato' | 'intermedio' | 'experto' | null;
  /** How central price is to their decision. alta = leads with discounts,
   *  media = considers but not blocker, baja = will pay for the right product. */
  price_sensitivity?: 'alta' | 'media' | 'baja' | null;
  /** Decision pace. ya = active outage / immediate need. semanas = weeks out.
   *  meses = planning ahead. sin_prisa = exploring. */
  urgency?: 'ya' | 'semanas' | 'meses' | 'sin_prisa' | null;
  /** Objection themes raised so far (up to 6). Used to address proactively in
   *  the next reply. Examples: 'envío', 'confianza', 'precio', 'técnico',
   *  'pago', 'compatibilidad'. */
  objection_themes?: string[];
  /** How the customer first arrived. Seeded on turn 1.
   *  Values: 'facebook_ad:<variant>' | 'organic' | null. */
  arrival_source?: string | null;
  /** Timestamp of the most recent read update (either Haiku or turn-1 seed). */
  last_updated_at?: string | null;
}

export interface CustomerProfile {
  phone_number: string;
  display_name: string | null;
  language: string | null;
  summary: string | null;
  facts: CustomerProfileFact[];
  reading: CustomerProfileReading | null;
  /** IANA timezone (e.g. "America/Havana"). NULL = unknown; callers
   *  should fall back to "America/New_York". Used by crons to enforce
   *  quiet hours so we don't nudge at 2am local. */
  user_timezone: string | null;
  last_extracted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── KB suggestion queue ────────────────────────────────────
export type KBSuggestionStatus = 'pending' | 'approved' | 'rejected';

export interface KBSuggestion {
  id: string;
  question: string;
  answer: string;
  category: string;
  status: KBSuggestionStatus;
  source_conversation_id: string | null;
  rationale: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  promoted_entry_id: string | null;
  created_at: string;
}

// ── Weekly overview / digest ───────────────────────────────
export interface OverviewMetrics {
  window_days: number;
  conversations_new: number;
  messages_customer: number;
  messages_sol: number;
  escalated: number;
  deep_conversations: number;
  /** Count of conversations with converted_at set within the window.
   *  Ground-truth sales marked by the operator via /won or dashboard. */
  conversions: number;
}

export interface RepeatedQuestion {
  sample: string;
  count: number;
  distinct_phones: number;
  last_seen: string;
}

export interface OverviewResponse {
  metrics: OverviewMetrics;
  top_questions: RepeatedQuestion[];
  lost_customers: LostCustomer[];
}

// ── Lost customers (engaged then went silent) ──────────────
export interface LostCustomer {
  conversation_id: string;
  phone_number: string;
  customer_name: string | null;
  user_message_count: number;
  last_message_at: string;
  last_message_role: MessageRole;
  last_message_snippet: string;
  hours_silent: number;
  escalated: boolean;
}

// ── Customer question feed (derived from messages) ─────────
export interface CustomerQuestion {
  message_id: string;
  conversation_id: string;
  phone_number: string;
  customer_name: string | null;
  content: string;
  created_at: string;
  conversation_status: ConversationStatus;
  escalated: boolean;
  handoff_detected: boolean;
}

export interface Handoff {
  id: string;
  conversation_id: string;
  reason: string;
  last_customer_message: string | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

export interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  category: string;
  source: string;
  times_used: number;
  created_at: string;
  updated_at: string;
}

// ── WhatsApp / Meta Cloud API types ────────────────────────

export interface WhatsAppWebhookBody {
  object: string;
  entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppChange {
  value: WhatsAppChangeValue;
  field: string;
}

export interface WhatsAppChangeValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
}

export interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

export interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

// ── Dashboard / UI types ────────────────────────────────────

export interface ConversationWithLastMessage extends Conversation {
  last_message?: Message;
  message_count?: number;
}

export interface DashboardStats {
  total_conversations: number;
  active_conversations: number;
  escalated_conversations: number;
  closed_conversations: number;
  messages_today: number;
}
