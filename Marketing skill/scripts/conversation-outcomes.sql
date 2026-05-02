-- Conversation-outcome schema migrations
-- ---------------------------------------------------------------------------
-- These migrations add the columns the marketing playbook depends on. They are
-- idempotent (safe to re-run). Run them in order; each is a separate logical
-- change, so they can be split across deploys.
--
-- After running, follow up with the queries in segmentation-queries.sql and
-- the dashboard queries in references/kpi-definitions.md.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. customers — marketing-relevant flags and last-campaign tracking
-- ===========================================================================
alter table customers
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists marketing_opt_in_at timestamptz,
  add column if not exists marketing_opt_in_source text,
  add column if not exists last_campaign_id uuid,
  add column if not exists last_campaign_sent_at timestamptz,
  add column if not exists do_not_message_until timestamptz,
  add column if not exists first_touch_channel text,    -- 'whatsapp' | 'web' | 'instagram' | …
  add column if not exists language text default 'es',
  -- Use-case tag — what the customer is buying for. Mirrors oiikon.com's four
  -- positioning pillars. Used to: (a) pick the right outbound template tone
  -- ("hurricane season is coming" vs "save on your light bill"), (b) skip
  -- seasonally-irrelevant sends (don't pitch hurricane prep in February),
  -- (c) report per-segment performance.
  -- Allowed values: 'hurricane' | 'home_emergency' | 'rv' | 'off_grid'
  --                 | 'cuba_diaspora' | 'unknown'
  -- Note: cuba_diaspora is a CULTURAL overlay — a single customer can be
  -- e.g. (rv, cuba_diaspora) or (hurricane, cuba_diaspora). When that's
  -- needed, switch to a junction table; for now most customers fit one tag.
  add column if not exists use_case text default 'unknown',
  add column if not exists use_case_inferred_at timestamptz,
  add column if not exists use_case_source text;        -- 'self_reported' | 'inferred_from_zip' | 'inferred_from_chat' | 'inferred_from_ad'

create index if not exists idx_customers_use_case
  on customers (use_case)
  where use_case <> 'unknown';

create index if not exists idx_customers_marketing_eligible
  on customers (marketing_opt_in, opted_out)
  where marketing_opt_in = true and opted_out = false;

create index if not exists idx_customers_last_campaign
  on customers (last_campaign_id);


-- ===========================================================================
-- 2. conversations — intent score, token + segment cost tracking
-- ===========================================================================
alter table conversations
  add column if not exists intent_score smallint,             -- 1..5, computed by Sol
  add column if not exists intent_classified_at timestamptz,
  add column if not exists tokens_used integer not null default 0,
  -- Count of Meta-billed conversations initiated (template send opens a 24h
  -- conversation window; Meta charges per conversation, not per message).
  add column if not exists meta_conversations_initiated integer not null default 0,
  add column if not exists outcome text,                      -- 'converted' | 'opted_out' | 'abandoned' | 'escalated' | …
  add column if not exists outcome_at timestamptz;

create index if not exists idx_conversations_intent
  on conversations (intent_score, created_at desc);

create index if not exists idx_conversations_outcome
  on conversations (outcome);


-- ===========================================================================
-- 3. campaigns — outbound campaign metadata
-- ===========================================================================
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  template_name text not null,                 -- Meta WA template name (must be approved in Business Manager)
  template_language text not null default 'es',-- BCP-47 language code, e.g. 'es', 'en_US'
  template_category text not null,             -- 'utility' | 'marketing' | 'authentication'
  segment_name text not null,                  -- named segment, e.g. 'abandoned-cart' (NOT raw SQL — see segmentation-queries.sql)
  recipients_count integer,
  cost_usd numeric(10,4),
  sent_at timestamptz,
  sent_by text,                                -- 'eduardo' | 'luz' | system user id
  hypothesis text,                             -- what we expected — for the weekly review
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_sent_at
  on campaigns (sent_at desc);


-- ===========================================================================
-- 3a. campaign_recipients — frozen audience snapshot per campaign
-- ===========================================================================
-- WHY: storing only the segment NAME on the campaign row is not a real audit.
-- Re-running the same query on a different day returns a different set. This
-- table freezes the exact list of customer_ids that went into THIS send, so:
--   - the weekly review can compute outcomes per recipient, not just totals
--   - a halted campaign can resume by skipping rows already in campaign_sends
--   - disputes ("did Sol message me?") can be answered definitively
create table if not exists campaign_recipients (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (campaign_id, customer_id)
);

create index if not exists idx_campaign_recipients_customer
  on campaign_recipients (customer_id);


-- ===========================================================================
-- 3b. campaign_sends — one row per Meta send attempt (success or failure)
-- ===========================================================================
-- WHY: Meta returns a wamid (WhatsApp Message ID) on every successful send.
-- That wamid is the join key for status webhooks (sent / delivered / read /
-- failed). Without persisting it we can't reconcile delivery, can't measure
-- read rates, and can't tell which message a customer is replying to. Failed
-- attempts also land here with the Meta error code, which is what powers the
-- per-failure response logic in outbound-campaign.ts.
create table if not exists campaign_sends (
  id bigserial primary key,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  status text not null,                        -- 'success' | 'failed'
  wamid text,                                  -- Meta WhatsApp Message ID, null on failure
  meta_error_code integer,                     -- Meta error code, null on success
  meta_error_raw text,                         -- raw error body for debugging
  unique (campaign_id, customer_id, attempted_at)
);

create index if not exists idx_campaign_sends_campaign
  on campaign_sends (campaign_id, status);

create index if not exists idx_campaign_sends_wamid
  on campaign_sends (wamid)
  where wamid is not null;


-- ===========================================================================
-- 3c. NO run_segment_sql RPC
-- ===========================================================================
-- Earlier drafts of outbound-campaign.ts called a `run_segment_sql(sql text)`
-- RPC that ran caller-supplied SQL on the service role. That's
-- SQL-injection-by-design — DO NOT create such a function.
--
-- Instead, segments live as named SQL files in scripts/segmentation-queries.sql
-- and are executed via typed Supabase clients (PostgREST `from(...).select()`)
-- or via named, parameterized RPCs that hard-code the SELECT statement and
-- only accept SAFE bind values (date ranges, intent thresholds). The campaign
-- runner then receives a typed Recipient[] from the caller, never a SQL string.


-- ===========================================================================
-- 4. opt-in evidence — proof for Meta audits and disputes
-- ===========================================================================
create table if not exists opt_in_evidence (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  opt_in_type text not null,                   -- 'general' | 'marketing'
  opted_in_at timestamptz not null default now(),
  source text not null,                        -- 'checkout-page' | 'facebook-leadform' | 'whatsapp-double-opt-in' | …
  evidence_url text,                           -- URL or storage reference to screenshot / form
  ip_address text,
  user_agent text,
  raw_payload jsonb                            -- full form data for completeness
);

create index if not exists idx_opt_in_evidence_customer
  on opt_in_evidence (customer_id, opted_in_at desc);


-- ===========================================================================
-- 5. RLS — keep the audit-skill rules consistent
-- ===========================================================================
-- The hardening skill already turned on RLS for customer-facing tables. The
-- new tables added here need the same treatment. Run as the postgres / owner
-- role.

alter table campaigns enable row level security;
alter table opt_in_evidence enable row level security;

-- Service role: full access (used by Sol's webhook + scheduled jobs).
drop policy if exists "service_role_all" on campaigns;
create policy "service_role_all" on campaigns
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all" on opt_in_evidence;
create policy "service_role_all" on opt_in_evidence
  for all to service_role using (true) with check (true);

-- Authenticated (admin UI): read-only.
drop policy if exists "authenticated_read" on campaigns;
create policy "authenticated_read" on campaigns
  for select to authenticated using (true);

drop policy if exists "authenticated_read" on opt_in_evidence;
create policy "authenticated_read" on opt_in_evidence
  for select to authenticated using (true);

-- anon (public): no access. (The default with RLS on; explicit for clarity.)


-- ===========================================================================
-- 6. Helpful joined view for the weekly review
-- ===========================================================================
create or replace view campaign_performance as
select
  cmp.id,
  cmp.name,
  cmp.template_category,
  cmp.sent_at,
  cmp.recipients_count,
  cmp.cost_usd,
  count(distinct o.id) as attributed_orders,
  coalesce(sum(o.total_amount), 0) as attributed_revenue,
  round(coalesce(sum(o.total_amount), 0) / nullif(cmp.cost_usd, 0), 2) as roi_multiple,
  count(distinct cust.id) filter (where cust.opted_out = true
    and cust.opted_out_at between cmp.sent_at and cmp.sent_at + interval '7 days') as opt_outs_7d
from campaigns cmp
left join customers cust on cust.last_campaign_id = cmp.id
left join orders o
  on o.customer_id = cust.id
 and o.created_at between cmp.sent_at and cmp.sent_at + interval '7 days'
group by cmp.id;
