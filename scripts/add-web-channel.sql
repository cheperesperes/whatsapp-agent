-- ============================================================
-- Add website chat channel to conversations
-- ============================================================
-- Apply this migration in the Supabase SQL editor BEFORE deploying
-- the website chat widget. It is purely additive — existing WhatsApp
-- conversations keep working unchanged.
--
-- Adds:
--   - conversations.channel       — 'whatsapp' (default) or 'web'
--   - conversations.web_session_id — UUID-like string for browser sessions
--   - relaxes phone_number NOT NULL so web rows can have a NULL phone
--     until the customer shares one

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp', 'web'));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS web_session_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_web_session_id_uidx
  ON conversations (web_session_id)
  WHERE web_session_id IS NOT NULL;

ALTER TABLE conversations
  ALTER COLUMN phone_number DROP NOT NULL;

-- A row must have at least one identifier
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_identifier_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_identifier_check
    CHECK (phone_number IS NOT NULL OR web_session_id IS NOT NULL);
