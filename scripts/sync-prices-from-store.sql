-- ============================================================
-- Sync agent_product_catalog with prices + stock from oiikon.com/admin/products
-- Captured 2026-04-13. Run in Supabase SQL editor.
-- ============================================================

-- Build a temp CTE of the store's source-of-truth values, then UPDATE
-- agent_product_catalog where sku matches. Any SKU missing from the
-- catalog is reported at the end.

WITH store_prices(sku, sell_price, stock_quantity, in_stock) AS (
  VALUES
    ('TROLLEY',                    99.00,    20,  true),
    ('EP3800-48V',                 699.00,   0,   true),
    ('F5000LFP',                   1999.00,  20,  true),
    ('F1000LFP',                   329.00,   20,  true),
    ('E3800LFP',                   1199.00,  20,  true),
    ('WB12200',                    399.00,   2,   true),
    ('SUNPAL-10K-1',               5500.00,  1,   true),
    ('SUNPAL-3K',                  2500.00,  1,   true),
    ('SUNPAL-3K-A',                2500.00,  1,   true),
    ('PP-Y4-10KWH',                775.00,   1,   true),
    ('SRN-SPI-10K-UP',             1199.00,  1,   true),
    ('HS-48V-100AH-3U-BT',         699.00,   3,   true),
    ('HS-48V-100AH-WALL',          799.00,   11,  true),
    ('E3600',                      0.00,     5,   false),
    ('E1000',                      0.00,     15,  false),
    ('E500',                       189.00,   18,  false),
    ('E1500',                      0.00,     10,  false),
    ('EB3000-24V',                 569.00,   0,   true),
    ('F3000LFP',                   799.00,   1,   true),
    ('SG48200T',                   2240.00,  3,   true),
    ('SG48100M',                   1120.00,  12,  true),
    ('POW-SunSmart 6.5KP',         1245.00,  3,   false),
    ('SPH5048P',                   789.00,   4,   true),
    ('SPH8048P',                   1499.00,  9,   true),
    ('POW-RELAB 5KU-SPLIT',        750.00,   2,   false),
    ('PECRON-E3000LFP',            2800.00,  5,   false),
    ('PECRON-E2000LFP',            1600.00,  10,  false),
    ('PECRON-E1000LFP',            847.00,   15,  false),
    ('B073TX1N5Q',                 15.00,    0,   false),
    ('L03YTJUSKBJ5000W-1',         1012.50,  6,   true),
    ('L13SR48100BV3.0-1',          828.00,   6,   true),
    ('11007001171',                445.00,   60,  true),
    ('energia-portatilse1000pv',   542.50,   11,  false),
    ('E2000LFP',                   599.00,   0,   true),
    ('SPH302480A',                 669.00,   6,   true),
    ('SPH6548P1',                  1378.75,  3,   false),
    ('SPH6548P',                   1239.00,  13,  true),
    ('1101800033',                 640.00,   23,  true),
    ('1500200172',                 2262.50,  11,  true),
    ('E2400LFP',                   599.00,   22,  true),
    ('E3600LFPX2',                 2599.00,  3,   true),
    ('PECR100PV',                  120.00,   10,  false),
    ('LIFELISUT',                  206.25,   20,  true),
    ('WATT12V100AH',               175.00,   62,  true),
    ('E3600LFP',                   1049.00,  11,  true),
    ('E1000LFP',                   369.00,   2,   true),
    ('E500LFP',                    189.00,   25,  true),
    ('E1500LFP',                   469.00,   6,   true),
    ('E300LFP',                    149.00,   78,  true),
    ('PECR200PV',                  199.00,   33,  true),
    ('PECR100PV1',                 109.00,   46,  true),
    ('PECR300PV',                  299.00,   9,   true)
)
UPDATE agent_product_catalog AS a
SET
  sell_price     = s.sell_price,
  stock_quantity = s.stock_quantity,
  in_stock       = s.in_stock AND s.stock_quantity > 0,
  updated_at     = now()
FROM store_prices s
WHERE a.sku = s.sku;

-- Report: SKUs present in the store but missing from agent_product_catalog
WITH store_skus(sku) AS (
  VALUES
    ('TROLLEY'),('EP3800-48V'),('F5000LFP'),('F1000LFP'),('E3800LFP'),
    ('WB12200'),('SUNPAL-10K-1'),('SUNPAL-3K'),('SUNPAL-3K-A'),('PP-Y4-10KWH'),
    ('SRN-SPI-10K-UP'),('HS-48V-100AH-3U-BT'),('HS-48V-100AH-WALL'),
    ('E3600'),('E1000'),('E500'),('E1500'),('EB3000-24V'),('F3000LFP'),
    ('SG48200T'),('SG48100M'),('POW-SunSmart 6.5KP'),('SPH5048P'),('SPH8048P'),
    ('POW-RELAB 5KU-SPLIT'),('PECRON-E3000LFP'),('PECRON-E2000LFP'),('PECRON-E1000LFP'),
    ('B073TX1N5Q'),('L03YTJUSKBJ5000W-1'),('L13SR48100BV3.0-1'),('11007001171'),
    ('energia-portatilse1000pv'),('E2000LFP'),('SPH302480A'),('SPH6548P1'),('SPH6548P'),
    ('1101800033'),('1500200172'),('E2400LFP'),('E3600LFPX2'),('PECR100PV'),
    ('LIFELISUT'),('WATT12V100AH'),('E3600LFP'),('E1000LFP'),('E500LFP'),
    ('E1500LFP'),('E300LFP'),('PECR200PV'),('PECR100PV1'),('PECR300PV')
)
SELECT s.sku AS missing_sku
FROM store_skus s
LEFT JOIN agent_product_catalog a ON a.sku = s.sku
WHERE a.sku IS NULL
ORDER BY s.sku;
