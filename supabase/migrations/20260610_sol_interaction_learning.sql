-- Daily Sol interaction-learning loop (WA agent owns these tables).
-- sol_interaction_reviews: one AI quality review per conversation per day,
-- scored against an Amazon-top-seller rubric (human warmth, customer
-- obsession, trust, proactivity, natural close, language/tone).
-- sol_learnings: distilled behavior directives consolidated from reviews.
-- Active rows are injected into Sol's system prompt as learned coaching.

create table if not exists public.sol_interaction_reviews (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  review_date date not null default current_date,
  overall_score int not null check (overall_score between 1 and 10),
  scores jsonb not null default '{}'::jsonb,
  customer_sentiment text,
  what_worked text,
  what_failed text,
  missed_opportunity text,
  candidate_learnings jsonb not null default '[]'::jsonb,
  message_count int not null default 0,
  language text,
  channel text,
  created_at timestamptz not null default now(),
  unique (conversation_id, review_date)
);

create index if not exists idx_sol_reviews_date on public.sol_interaction_reviews (review_date desc);
create index if not exists idx_sol_reviews_score on public.sol_interaction_reviews (overall_score);

-- Service-role access only (all reads/writes go through API routes).
alter table public.sol_interaction_reviews enable row level security;

create table if not exists public.sol_learnings (
  id uuid primary key default gen_random_uuid(),
  directive text not null,
  category text not null default 'general',
  rationale text,
  status text not null default 'active' check (status in ('active','retired')),
  source text not null default 'auto' check (source in ('auto','manual')),
  times_reinforced int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sol_learnings_status on public.sol_learnings (status);

alter table public.sol_learnings enable row level security;

comment on table public.sol_interaction_reviews is 'Daily AI quality reviews of Sol WhatsApp/web conversations (Amazon-top-seller rubric). Written by /api/cron/sol-learning.';
comment on table public.sol_learnings is 'Distilled behavior directives from interaction reviews. Active rows are injected into Sol''s system prompt. source=manual rows are operator coaching and never auto-retired.';
