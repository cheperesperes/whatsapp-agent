-- Consented contact info for WEB CHAT visitors (the Sol widget on oiikon.com).
-- A row exists ONLY when the visitor typed their email into the widget's
-- opt-in card and ticked the consent checkbox (consent_text stores the exact
-- wording they agreed to, for the legal record). Powers the one-time
-- "you left something behind" follow-up email. Service-role only.
-- APPLIED to prod 2026-06-11 via mcp apply_migration (web_lead_contacts).
create table if not exists public.web_lead_contacts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  email text not null,
  language text not null default 'es' check (language in ('es', 'en')),
  consent_marketing boolean not null default false,
  consent_text text not null,
  product_sku text,
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed')),
  followup_sent_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists web_lead_contacts_pending_idx
  on public.web_lead_contacts (created_at)
  where followup_sent_at is null and status = 'subscribed';
create unique index if not exists web_lead_contacts_conv_email_uidx
  on public.web_lead_contacts (conversation_id, lower(email));

alter table public.web_lead_contacts enable row level security;
