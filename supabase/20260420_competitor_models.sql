-- ============================================================
-- Competitor models — what other brands offer, used by Sol to
-- pivot respectfully when a customer asks about EcoFlow / Jackery /
-- Bluetti / Anker / Goal Zero. Sol never trash-talks; she validates
-- the brand and reframes on $/Wh (cost per watt-hour stored).
--
-- Two tables:
--   1. competitor_models  — the data Sol reads from. Editable from
--      /dashboard/competitors. `manually_overridden_at` blocks the
--      auto-refresh cron (mirrors agent_product_catalog pattern).
--   2. competitor_refresh_log — audit trail of every change the
--      cron writes. One row per (brand, model, field) per run.
-- ============================================================

CREATE TABLE IF NOT EXISTS competitor_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  capacity_wh INTEGER NOT NULL,
  inverter_watts INTEGER,
  current_price_usd NUMERIC(10,2) NOT NULL,
  chemistry TEXT,                          -- 'LFP' (LiFePO4) | 'NMC'
  warranty_years INTEGER,
  source_url TEXT,                         -- where the auto-refresh cron re-checks the price
  active BOOLEAN NOT NULL DEFAULT TRUE,    -- include this model in Sol's prompt context?
  notes TEXT,                              -- operator notes ("on sale, normally $999")
  manually_overridden_at TIMESTAMPTZ,      -- skip auto-refresh if recent
  last_refreshed_at TIMESTAMPTZ,           -- last successful auto-refresh
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT competitor_models_brand_model_uq UNIQUE (brand, model)
);

CREATE INDEX IF NOT EXISTS idx_competitor_models_brand ON competitor_models(brand);
CREATE INDEX IF NOT EXISTS idx_competitor_models_capacity ON competitor_models(capacity_wh);
CREATE INDEX IF NOT EXISTS idx_competitor_models_active ON competitor_models(active) WHERE active = TRUE;

COMMENT ON TABLE competitor_models IS
  'Curated competitor catalog. Sol injects these into her prompt so she can pivot to $/Wh comparisons when a customer mentions another brand. Editable from /dashboard/competitors. Auto-refreshed weekly by /api/cron/refresh-competitors unless manually_overridden_at is recent.';

COMMENT ON COLUMN competitor_models.manually_overridden_at IS
  'Set to NOW() when an operator edits the price from the dashboard. The auto-refresh cron skips rows whose override is younger than COMPETITOR_REFRESH_OVERRIDE_TTL_HOURS (default 168h = 7d).';

CREATE TABLE IF NOT EXISTS competitor_refresh_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  field TEXT NOT NULL,                     -- 'current_price_usd' typically
  old_value TEXT,
  new_value TEXT,
  source_url TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_competitor_refresh_log_run ON competitor_refresh_log(run_id);
CREATE INDEX IF NOT EXISTS idx_competitor_refresh_log_model_time ON competitor_refresh_log(brand, model, changed_at DESC);

COMMENT ON TABLE competitor_refresh_log IS
  'Audit trail of every change applied by /api/cron/refresh-competitors. One row per (brand, model, field) per run. Use this to debug price drift or roll back a bad refresh.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed data — verified against each brand''s official site on 2026-04-20.
-- All prices in USD. capacity_wh is the manufacturer-published nominal
-- watt-hour rating. Auto-refresh will keep prices current.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO competitor_models (brand, model, capacity_wh, inverter_watts, current_price_usd, chemistry, warranty_years, source_url, last_refreshed_at, notes) VALUES
  -- ECOFLOW (us.ecoflow.com/collections/portable-power-stations)
  ('EcoFlow', 'DELTA 2',                1024, 1800,  449.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-2-portable-power-station',         NOW(), 'Most-asked competitor model'),
  ('EcoFlow', 'DELTA 3',                1024, 1800,  699.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-portable-power-station',         NOW(), null),
  ('EcoFlow', 'DELTA 3 Plus',           1024, 1800,  699.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-plus-portable-power-station',    NOW(), null),
  ('EcoFlow', 'DELTA 3 Classic',        1024, 1800,  449.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-classic',                        NOW(), null),
  ('EcoFlow', 'DELTA 3 1500',           1536, 1800,  599.00, 'LFP', 10, 'https://us.ecoflow.com/products/delta-3-1500-portable-power-station',    NOW(), null),
  ('EcoFlow', 'DELTA 2 Max',            2048, 2400,  849.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-2-max-portable-power-station',     NOW(), null),
  ('EcoFlow', 'DELTA 3 Max Plus',       2048, 3000, 1099.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-max-plus',                       NOW(), null),
  ('EcoFlow', 'DELTA 3 Ultra',          3072, 3600, 1299.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-ultra',                          NOW(), null),
  ('EcoFlow', 'DELTA 3 Ultra Plus',     3072, 3600, 1449.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-3-ultra-plus',                     NOW(), null),
  ('EcoFlow', 'DELTA Pro',              3600, 3600, 1899.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-pro-portable-power-station',       NOW(), null),
  ('EcoFlow', 'DELTA Pro 3',            4096, 4000, 2599.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-pro-3',                            NOW(), null),
  ('EcoFlow', 'DELTA Pro Ultra',        6144, 7200, 4099.00, 'LFP',  5, 'https://us.ecoflow.com/products/delta-pro-ultra',                        NOW(), null),
  ('EcoFlow', 'RIVER 2',                 256,  300,  179.00, 'LFP', 10, 'https://us.ecoflow.com/products/river-2-portable-power-station',         NOW(), null),
  ('EcoFlow', 'RIVER 2 Max',             512,  500,  269.00, 'LFP', 10, 'https://us.ecoflow.com/products/river-2-max-portable-power-station',     NOW(), null),
  ('EcoFlow', 'RIVER 2 Pro',             768,  800,  315.00, 'LFP', 10, 'https://us.ecoflow.com/products/river-2-pro-portable-power-station',     NOW(), null),

  -- JACKERY (jackery.com/products/...)
  ('Jackery', 'Explorer 1000 v2',       1070, 1500,  499.00, 'LFP',  5, 'https://www.jackery.com/products/explorer-1000-v2-portable-power-station', NOW(), null),
  ('Jackery', 'Explorer 1000 Plus',     1264, 2000,  599.00, 'LFP',  5, 'https://www.jackery.com/products/explorer-1000-plus-portable-power-station', NOW(), null),
  ('Jackery', 'Explorer 2000 v2',       2042, 2200,  799.00, 'LFP',  5, 'https://www.jackery.com/products/explorer-2000-v2-portable-power-station', NOW(), null),
  ('Jackery', 'Explorer 2000 Plus',     2042, 3000,  899.00, 'LFP',  5, 'https://www.jackery.com/products/jackery-explorer-2000-plus-portable-power-station', NOW(), null),
  ('Jackery', 'HomePower 3000',         3072, 3600, 1299.00, 'LFP',  5, 'https://www.jackery.com/products/jackery-homepower-3000', NOW(), null),

  -- BLUETTI (bluettipower.com)
  ('Bluetti', 'AC180',                  1152, 1800,  499.00, 'LFP',  5, 'https://www.bluettipower.com/products/ac180',     NOW(), 'Often on sale at $449'),
  ('Bluetti', 'Elite 100 V2',           1024, 1800,  399.00, 'LFP',  5, 'https://www.bluettipower.com/products/elite-100-v2', NOW(), null),
  ('Bluetti', 'AC200L',                 2048, 2400,  899.00, 'LFP',  5, 'https://www.bluettipower.com/products/ac200l',    NOW(), null),
  ('Bluetti', 'Elite 200 V2',           2074, 2600,  799.00, 'LFP',  5, 'https://www.bluettipower.com/products/elite-200-v2', NOW(), null),
  ('Bluetti', 'Apex 300',               2765, 3000, 1499.00, 'LFP',  5, 'https://www.bluettipower.com/products/apex-300',  NOW(), null),
  ('Bluetti', 'Elite 300',              3014, 3000, 1199.00, 'LFP',  5, 'https://www.bluettipower.com/products/elite-300', NOW(), null),
  ('Bluetti', 'Elite 400',              3840, 4000, 1299.00, 'LFP',  5, 'https://www.bluettipower.com/products/elite-400', NOW(), null),

  -- ANKER SOLIX (ankersolix.com)
  ('Anker SOLIX', 'C1000',              1056, 1800,  429.00, 'LFP',  5, 'https://www.ankersolix.com/products/c1000',  NOW(), null),
  ('Anker SOLIX', 'C1000 Gen 2',        1024, 1800,  449.00, 'LFP',  5, 'https://www.ankersolix.com/products/c1000-gen-2', NOW(), null),
  ('Anker SOLIX', 'F2000',              2048, 2400,  799.00, 'LFP',  5, 'https://www.ankersolix.com/products/f2000', NOW(), null),
  ('Anker SOLIX', 'F3000',              3072, 3600, 1499.00, 'LFP',  5, 'https://www.ankersolix.com/products/f3000', NOW(), null),
  ('Anker SOLIX', 'F3800',              3840, 6000, 1899.00, 'LFP',  5, 'https://www.ankersolix.com/products/f3800', NOW(), null),
  ('Anker SOLIX', 'F3800 Plus',         3840, 6000, 2399.00, 'LFP',  5, 'https://www.ankersolix.com/f3800-plus',     NOW(), null),

  -- GOAL ZERO (goalzero.com)
  ('Goal Zero', 'Yeti 300',              297,  350,  349.95, 'LFP',  5, 'https://www.goalzero.com/products/yeti-300',      NOW(), null),
  ('Goal Zero', 'Yeti 500',              499,  500,  499.95, 'LFP',  5, 'https://www.goalzero.com/products/yeti-500',      NOW(), null),
  ('Goal Zero', 'Yeti 700',              677,  600,  699.95, 'LFP',  5, 'https://www.goalzero.com/products/yeti-700',      NOW(), null),
  ('Goal Zero', 'Yeti 1500',            1505, 2000, 1499.95, 'LFP', 10, 'https://www.goalzero.com/products/yeti-1500',     NOW(), null),
  ('Goal Zero', 'Yeti PRO 4000',        3994, 3600, 3399.95, 'LFP', 10, 'https://www.goalzero.com/products/yeti-pro-4000', NOW(), null)
ON CONFLICT (brand, model) DO NOTHING;
