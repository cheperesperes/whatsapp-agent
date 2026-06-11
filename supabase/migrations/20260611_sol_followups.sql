-- Ledger of every automated/suggested follow-up touch the Sol agent makes.
-- Source of truth for "how many times has this lead been nudged" — replaces
-- fragile text-marker scanning. Service-role access only (RLS on, no policies),
-- consistent with ad_url_map.
-- APPLIED to prod 2026-06-11 via mcp apply_migration (sol_followups_ledger).
create table if not exists public.sol_followups (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  phone_number text not null,
  kind text not null check (kind in ('quote_nudge', 'window_close_nudge', 'paylink_nudge', 'manual_chase')),
  sku text,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists sol_followups_conv_idx
  on public.sol_followups (conversation_id, created_at desc);
create index if not exists sol_followups_created_idx
  on public.sol_followups (created_at desc);

alter table public.sol_followups enable row level security;
