-- Fix: marketing campaign generation fails with
--   "new row for relation marketing_content violates check constraint
--    marketing_content_video_status_check"
--
-- The video-gating work (image-only campaigns + non-primary-language posts)
-- writes video_status = 'skipped' (app/api/cron/marketing-daily/route.ts), but
-- the original CHECK constraint (20260423_marketing_agent.sql) only allowed
-- ('pending','processing','ready','failed'). The matching DB change was never
-- shipped, so EVERY image-only / video-skipped generation 500s at the save
-- step and the campaign lands in 'failed'.
--
-- Additive, non-breaking: widen the allowed set to include 'skipped'. Existing
-- rows (only 'pending'/'processing' in prod) are unaffected.

ALTER TABLE marketing_content
  DROP CONSTRAINT IF EXISTS marketing_content_video_status_check;

ALTER TABLE marketing_content
  ADD CONSTRAINT marketing_content_video_status_check
  CHECK (video_status IN ('pending', 'processing', 'ready', 'failed', 'skipped'));
