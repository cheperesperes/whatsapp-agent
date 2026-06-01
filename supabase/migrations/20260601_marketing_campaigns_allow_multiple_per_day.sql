-- Feature: unlimited marketing campaigns per day (operator can "Run new
-- campaign" as many times as they want; ES/EN/bundles each get their own post).
--
-- The original schema put a UNIQUE index on `date` alone
-- (marketing_campaigns_date_key), which hard-limited the table to ONE campaign
-- per calendar day — it even prevented the ES+EN "both" flow from creating two
-- rows. Drop it so multiple campaigns can share a date. Each campaign is still
-- uniquely identified by its `id` (primary key), which is what the app keys on.
--
-- Non-destructive: only removes the over-restrictive UNIQUE constraint; no data
-- is changed. The scheduled daily cron stays idempotent in application code
-- (getCampaignByDate + skip-unless-force), so it still produces one auto post
-- per day; only manual "new=true" runs create additional rows.

ALTER TABLE marketing_campaigns
  DROP CONSTRAINT IF EXISTS marketing_campaigns_date_key;

-- Some Postgres setups expose it as a bare unique index rather than a named
-- table constraint — drop that form too, just in case.
DROP INDEX IF EXISTS marketing_campaigns_date_key;
