-- ============================================================
-- Inventory sync from oiikon.com → agent
-- Both apps share this Supabase project. The website is the source of
-- truth for `products`; the agent reads from `agent_product_catalog`.
-- A scheduled job (/api/cron/sync-inventory) keeps the agent's
-- price/stock in sync with the website every 10 minutes.
--
-- This migration adds:
--   1. `manually_overridden_at` on agent_product_catalog so an operator
--      edit from the dashboard isn't silently clobbered by the next sync.
--   2. `inventory_sync_log` for an auditable record of every change the
--      sync writes (one row per field-change, per SKU, per run).
-- ============================================================

ALTER TABLE agent_product_catalog
  ADD COLUMN IF NOT EXISTS manually_overridden_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_product_catalog.manually_overridden_at IS
  'Set to NOW() when an operator edits this row from the dashboard. The cron sync skips rows whose override is younger than INVENTORY_SYNC_OVERRIDE_TTL_HOURS (default 24h) so deliberate operator changes are not auto-reverted.';

CREATE TABLE IF NOT EXISTS inventory_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  sku TEXT NOT NULL,
  field TEXT NOT NULL,           -- 'sell_price' | 'in_stock' | 'stock_quantity' | 'original_price' | 'discount_percentage'
  old_value TEXT,                -- stringified for one-column-fits-all
  new_value TEXT,
  source TEXT NOT NULL DEFAULT 'website',  -- always 'website' for the cron
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_sync_log_run ON inventory_sync_log(run_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sync_log_sku_time ON inventory_sync_log(sku, changed_at DESC);

COMMENT ON TABLE inventory_sync_log IS
  'Audit trail of every change applied by /api/cron/sync-inventory. One row per (sku, field) per run. Use this to debug "why did this product price change?" or to roll back a bad sync.';
