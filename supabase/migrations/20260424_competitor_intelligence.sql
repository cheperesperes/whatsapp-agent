-- Competitor Intelligence — anonymous learning from customer mentions
--
-- When a customer mentions a competitor (Amazon, Alibaba, Bluetti, etc.) in
-- conversation, we extract the mention and persist it WITHOUT any PII —
-- no phone number, no conversation_id, no customer name. Just the signal:
-- which competitor, which product, what price, when, in what language.
--
-- An aggregator cron computes medians per (product_sku, competitor) pair so
-- Sol can cite honest market data in comparisons ("Amazon anda cerca de $215").
-- Retention: 180 days (deleted by retention cron).

CREATE TABLE IF NOT EXISTS competitor_mentions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- What product the customer was looking at when they mentioned the competitor.
  -- SKU may be null if the extractor can't resolve it (e.g. generic "estación solar").
  product_sku TEXT,
  -- Competitor name, normalized to lowercase (amazon, alibaba, bluetti, ecoflow,
  -- jackery, anker, etc.). Free text so we don't constrain future marketplaces.
  competitor_name TEXT NOT NULL,
  -- Price the CUSTOMER claims they saw. May be null if they mentioned the
  -- competitor without a price ("en Amazon es más barato" without a number).
  mentioned_price_usd NUMERIC,
  -- Original price + currency if the customer quoted non-USD ("en Alibaba vi $15000 MXN").
  original_price NUMERIC,
  original_currency TEXT,
  -- One-sentence summary of the customer's framing — helps the operator review
  -- anomalous mentions without needing the original message.
  context_summary TEXT,
  -- ISO language code of the mention ('es', 'en'). Sol responds per-language so
  -- tracking this lets us know which objections are common in each language.
  language TEXT DEFAULT 'es',
  mentioned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS competitor_mentions_sku_idx ON competitor_mentions (product_sku, competitor_name, mentioned_at DESC);
CREATE INDEX IF NOT EXISTS competitor_mentions_at_idx ON competitor_mentions (mentioned_at DESC);

-- Aggregated stats per (product_sku, competitor_name). Recomputed daily by
-- /api/cron/competitor-stats. Sol reads from this, never from the raw mentions
-- (cheaper + bounded size).
CREATE TABLE IF NOT EXISTS competitor_stats (
  product_sku TEXT NOT NULL,
  competitor_name TEXT NOT NULL,
  -- Stats computed over the most recent 30 days of mentions only — older
  -- mentions are too stale for competitive quoting.
  sample_size INTEGER NOT NULL,
  median_price_usd NUMERIC,
  min_price_usd NUMERIC,
  max_price_usd NUMERIC,
  last_mentioned_at TIMESTAMPTZ,
  recomputed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_sku, competitor_name)
);

CREATE INDEX IF NOT EXISTS competitor_stats_sku_idx ON competitor_stats (product_sku);

-- Retention helper: delete mentions older than 180 days. Called by the
-- aggregator cron at the end of its run.
CREATE OR REPLACE FUNCTION purge_old_competitor_mentions()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
BEGIN
  DELETE FROM competitor_mentions WHERE mentioned_at < NOW() - INTERVAL '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;
