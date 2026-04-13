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

export interface Conversation {
  id: string;
  phone_number: string;
  customer_name: string | null;
  customer_segment: CustomerSegment;
  status: ConversationStatus;
  escalated: boolean;
  escalation_reason: string | null;
  product_interest: string | null;
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
