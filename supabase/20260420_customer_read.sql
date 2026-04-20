-- ============================================================
-- Customer read v1 — structured behavioral signals per contact.
--
-- Background: customer_profiles already stores display_name, language,
-- summary, and a free-form facts[] array. What's missing is a STRUCTURED
-- read that Sol can use to adapt tone and content in real time:
--   • intent_stage: where in the funnel are they right now
--   • knowledge_level: beginner vs technical — drives vocabulary
--   • price_sensitivity: drives whether to lead with value or price
--   • urgency: drives closing pace (now vs weeks vs no hurry)
--   • objection_themes: what to address proactively on the next reply
--   • arrival_source: seeded on turn 1 (fb_ad variant vs organic)
--
-- Why JSONB (not one column per field): the dimensions will evolve — we'll
-- add more as we learn what signals drive conversion. JSONB lets us
-- iterate without a migration per field. The Haiku extractor writes this;
-- Sol reads a formatted version of it in every turn's system prompt.
-- ============================================================

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS reading JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN customer_profiles.reading IS
  'Structured behavioral read used to adapt Sol''s tone/content. Shape: {intent_stage, knowledge_level, price_sensitivity, urgency, objection_themes[], arrival_source, last_updated_at}. All fields optional — Haiku emits only what it has signal on; null means unknown.';

-- Partial index so the dashboard can filter by reading dimension cheaply
-- (e.g. "show me all leads at listo_comprar"). Only indexes rows that have
-- a non-empty reading, keeping the index tiny.
CREATE INDEX IF NOT EXISTS idx_customer_profiles_reading_stage
  ON customer_profiles ((reading->>'intent_stage'))
  WHERE reading ? 'intent_stage';
