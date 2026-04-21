-- ============================================================
-- Customer timezone — for quiet-hours enforcement on outbound crons.
--
-- Problem: the followup cron fires every hour in UTC. For a customer in
-- Havana (UTC-5), the cron's idea of "now" is 5 hours off their wall
-- clock, so an 18-24h window can land at 2am local. Getting a sales
-- nudge at 2am is an opt-out trigger, not a conversion lever.
--
-- Shape: one IANA timezone string per customer_profile. NULL means
-- "unknown — use default" (America/New_York works for Miami ops + Cuba
-- customers equally well; both fall within [-4, -5] offset year-round).
-- Seeded on turn 1 from phone country code; can be overridden later by
-- the extractor or by an operator.
-- ============================================================

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS user_timezone TEXT NULL;

COMMENT ON COLUMN customer_profiles.user_timezone IS
  'IANA timezone string (e.g. America/Havana). NULL = unknown, callers should fall back to America/New_York. Seeded from phone country code on turn 1; crons use it to enforce quiet hours.';
