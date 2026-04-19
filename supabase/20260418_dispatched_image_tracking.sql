-- ============================================================
-- Track product images already dispatched per conversation
-- so Sol never re-sends the same image on follow-up turns.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS recent_dispatched_skus JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN conversations.recent_dispatched_skus IS
  'Array of {sku: string, at: ISO timestamp}. Recent SKUs whose product image was already sent to this customer. Server-side filter + LLM prompt context both read this to avoid re-sending the same photo.';
