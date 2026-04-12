-- Oiikon WhatsApp Agent Database Schema
-- This schema manages conversations, messages, products, and handoffs for the customer service system.

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text UNIQUE NOT NULL,
  customer_name text,
  customer_segment text CHECK (customer_segment IN ('cuban_family', 'general', 'unknown')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'escalated', 'closed')),
  escalated boolean NOT NULL DEFAULT false,
  escalation_reason text,
  product_interest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  handoff_detected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text UNIQUE NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  brand text NOT NULL,
  capacity_wh integer,
  output_watts integer,
  price_usd decimal(10, 2) NOT NULL,
  price_includes_cuba_shipping boolean NOT NULL DEFAULT true,
  in_stock boolean NOT NULL DEFAULT true,
  description_es text,
  ideal_for text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Handoffs table
CREATE TABLE IF NOT EXISTS handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason text NOT NULL,
  last_customer_message text,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_phone_number ON conversations(phone_number);

-- Enable Row Level Security (RLS)
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for conversations
CREATE POLICY "service_role_all_conversations" ON conversations
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_select_conversations" ON conversations
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- RLS Policies for messages
CREATE POLICY "service_role_all_messages" ON messages
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_select_messages" ON messages
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- RLS Policies for products
CREATE POLICY "service_role_all_products" ON products
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_select_products" ON products
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- RLS Policies for handoffs
CREATE POLICY "service_role_all_handoffs" ON handoffs
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_select_handoffs" ON handoffs
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- Enable realtime on conversations and messages
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
