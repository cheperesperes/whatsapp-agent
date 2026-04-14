-- ============================================================
-- Twilio MessageSid idempotency
-- Adds a nullable column to store the inbound Twilio MessageSid
-- and a partial unique index so retries of the same webhook
-- deliver identical inserts without duplicating messages.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS twilio_message_sid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_twilio_sid_uidx
  ON messages (twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;

-- Quick sanity check (run these to verify)
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'messages' AND column_name = 'twilio_message_sid';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'messages';
