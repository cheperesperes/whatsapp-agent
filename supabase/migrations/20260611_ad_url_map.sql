-- Operator-maintained ad URL → product map (WA-agent-owned). Lets Sol resolve a
-- brand-new ad's product on the FIRST lead even when Meta's CTWA referral sends
-- no headline. Managed from /dashboard/ads. Applied to prod 2026-06-11.
create table if not exists public.ad_url_map (
  id uuid primary key default gen_random_uuid(),
  ad_url text not null unique,
  sku text,
  product_name text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ad_url_map enable row level security;
comment on table public.ad_url_map is 'Operator-maintained map of FB/IG ad URL → product (SKU). Used by the WhatsApp webhook to resolve the ad product when the Meta CTWA referral lacks a headline. Managed from /dashboard/ads.';

-- Seeded once from conversations.ad_source history (URLs already seen WITH a product).
