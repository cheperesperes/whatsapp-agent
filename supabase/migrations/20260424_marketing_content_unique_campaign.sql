-- Enforce one content row per campaign.
--
-- Concurrent ?force=true regenerate calls previously raced: each one deleted
-- the existing content row, then each inserted a fresh one → 2 rows for the
-- same campaign, and the dashboard rendered whichever the join returned first.
--
-- With this constraint, createContent() upserts on campaign_id and a
-- duplicate insert simply overwrites. Safe + idempotent under concurrency.

ALTER TABLE marketing_content ADD CONSTRAINT marketing_content_campaign_id_key UNIQUE (campaign_id);
