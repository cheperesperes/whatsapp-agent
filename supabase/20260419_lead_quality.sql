-- ============================================================
-- Lead-quality scoring (Haiku 4.5 background job).
-- After each customer turn, classify the lead as hot/warm/cold/dead
-- so Eduardo can triage instead of scrolling 100+ conversations.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS lead_quality TEXT
    CHECK (lead_quality IN ('hot', 'warm', 'cold', 'dead')),
  ADD COLUMN IF NOT EXISTS lead_reason TEXT,
  ADD COLUMN IF NOT EXISTS recommended_action TEXT,
  ADD COLUMN IF NOT EXISTS lead_scored_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conversations_lead_quality_idx
  ON conversations (lead_quality, updated_at DESC)
  WHERE lead_quality IS NOT NULL;

COMMENT ON COLUMN conversations.lead_quality IS
  'hot = ready to buy / asked for link / strong intent; warm = engaged but undecided; cold = curious or low signal; dead = ghosted, opt-out, or off-topic. Set by Haiku scorer after each customer message.';
COMMENT ON COLUMN conversations.lead_reason IS
  'One-sentence rationale from the lead-quality scorer (max 200 chars).';
COMMENT ON COLUMN conversations.recommended_action IS
  'One-sentence next step suggested by the scorer (max 200 chars).';
COMMENT ON COLUMN conversations.lead_scored_at IS
  'Timestamp of the most recent lead-quality scoring run.';
