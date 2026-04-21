-- ============================================================
-- Deals-closed counter — track sales Sol helped close.
--
-- Problem: the dashboard reports messages sent, conversations started,
-- and escalations — but never counts the actual outcome (did the customer
-- buy?). Without that, we can't distinguish "agent responded to 100
-- people" from "agent closed 3 sales." The weekly overview shows volume
-- but not value.
--
-- Shape: one TIMESTAMPTZ column on conversations. NULL = not converted.
-- Set once when operator marks the conversation won via the dashboard
-- button or the /won <phone> WhatsApp command. Never auto-set — this is
-- ground truth, operator-confirmed, so the metric is trustworthy.
--
-- A partial index makes "count conversions in last N days" fast even as
-- the conversations table grows.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN conversations.converted_at IS
  'When the operator confirmed this conversation led to a sale. NULL = not converted. Set via dashboard button or /won <phone> command. Never auto-set.';

CREATE INDEX IF NOT EXISTS idx_conversations_converted_at
  ON conversations (converted_at DESC)
  WHERE converted_at IS NOT NULL;
