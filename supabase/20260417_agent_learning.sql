-- ============================================================
-- Agent learning + personalization
-- 1. Flag products that support an external battery add-on
-- 2. Per-customer profile (auto-learned facts)
-- 3. Cross-conversation KB suggestion queue (pending operator review)
-- ============================================================

-- 1. External battery compatibility flag
ALTER TABLE agent_product_catalog
  ADD COLUMN IF NOT EXISTS supports_external_battery BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN agent_product_catalog.supports_external_battery IS
  'TRUE if this product can accept an external battery expansion. Sol mentions this when recommending.';

-- 2. Customer profiles
CREATE TABLE IF NOT EXISTS customer_profiles (
  phone_number TEXT PRIMARY KEY,
  display_name TEXT,
  language TEXT,
  summary TEXT,
  facts JSONB DEFAULT '[]'::jsonb,
  last_extracted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE customer_profiles IS
  'Auto-learned per-customer facts extracted from WhatsApp conversations. Keyed by E.164 phone.';
COMMENT ON COLUMN customer_profiles.facts IS
  'Array of {fact: string, source_msg_id: uuid|null, verified_at: timestamptz} objects.';

CREATE INDEX IF NOT EXISTS idx_customer_profiles_updated_at
  ON customer_profiles(updated_at DESC);

-- 3. KB suggestion queue (pending operator review)
CREATE TABLE IF NOT EXISTS kb_suggestions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  rationale TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  promoted_entry_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE kb_suggestions IS
  'Auto-extracted KB entry candidates from conversations. Operator approves/rejects in dashboard.';

CREATE INDEX IF NOT EXISTS idx_kb_suggestions_status
  ON kb_suggestions(status, created_at DESC);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on customer_profiles"
  ON customer_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on kb_suggestions"
  ON kb_suggestions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users read customer_profiles"
  ON customer_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users read kb_suggestions"
  ON kb_suggestions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users update kb_suggestions"
  ON kb_suggestions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- updated_at trigger for customer_profiles
-- ============================================================
CREATE TRIGGER update_customer_profiles_updated_at
  BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
