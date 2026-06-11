-- Cross-instance webhook idempotency: one stored message per Meta wamid.
-- Verified 0 duplicate twilio_message_sid values before applying (798 rows
-- with sid). Partial: assistant/system messages have NULL sid (unconstrained).
-- APPLIED to prod 2026-06-11 via mcp apply_migration (messages_wamid_unique).
create unique index if not exists messages_twilio_message_sid_uidx
  on public.messages (twilio_message_sid)
  where twilio_message_sid is not null;
