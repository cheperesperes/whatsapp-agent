-- ============================================================
-- Expose product discounts to the WhatsApp agent
-- Sol needs original_price + discount_percentage to mention
-- promos and compute a correct "effective sell price" at quote time.
-- ============================================================

ALTER TABLE agent_product_catalog
  ADD COLUMN IF NOT EXISTS original_price NUMERIC,
  ADD COLUMN IF NOT EXISTS discount_percentage NUMERIC DEFAULT 0;

COMMENT ON COLUMN agent_product_catalog.original_price IS
  'MSRP / pre-discount list price. When NULL, assume no discount is active and sell_price is the displayed price.';
COMMENT ON COLUMN agent_product_catalog.discount_percentage IS
  'Current discount in percent (0-100). When > 0, Sol mentions "X% off" and quotes sell_price * (1 - discount/100) as the customer-facing price.';

-- One-time sync from products table
UPDATE agent_product_catalog a
SET
  original_price = p.original_price,
  discount_percentage = COALESCE(p.discount_percentage, 0)
FROM products p
WHERE a.sku = p.sku;
