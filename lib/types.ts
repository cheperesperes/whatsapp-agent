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
  created_at?: string;
  updated_at?: string;
}

// ── Customer profile (auto-learned per contact) ─────────────
export interface CustomerProfileFact {
  fact: string;
  source_msg_id: string | null;
  verified_at: string;
}

export interface CustomerProfile {
  phone_number: string;
  display_name: string | null;
  language: string | null;
  summary: string | null;
  facts: CustomerProfileFact[];
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
