-- Rename the legacy `twilio_message_sid` column to `provider_message_id`.
-- The column now stores Meta wamids (since Twilio was removed). The column
-- name is the only thing that's still Twilio-flavored.
--
-- Apply manually in the Supabase SQL editor when you're ready. Code reads
-- the column via lib/supabase.ts; if you run this, ALSO update
-- lib/supabase.ts to use the new column name in:
--   - storeMessage   (line that sets payload.twilio_message_sid)
--   - hasProcessedMessageSid  (.eq('twilio_message_sid', sid))
-- Otherwise the agent will silently lose idempotency.
--
-- Until the rename is applied, the existing code keeps working as-is.

ALTER TABLE messages
  RENAME COLUMN twilio_message_sid TO provider_message_id;

ALTER INDEX IF EXISTS messages_twilio_sid_uidx
  RENAME TO messages_provider_message_id_uidx;
