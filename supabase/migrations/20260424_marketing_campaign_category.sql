-- Add optional category label to marketing_campaigns so the operator can
-- steer each day's content theme (education, tips, installation, etc.)
-- and we can filter/analyse performance per category later.
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS category TEXT;
CREATE INDEX IF NOT EXISTS marketing_campaigns_category_idx ON marketing_campaigns (category);
