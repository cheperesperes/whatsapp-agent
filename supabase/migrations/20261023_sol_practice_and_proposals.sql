-- Sol v2 learning loop (2026-10-23)
-- 1) Coaching rules can now be PROPOSED (waiting for owner approval) or REJECTED,
--    and can come from the nightly practice chats.
-- 2) Practice-run results are stored for the Aprendizaje page.
-- Additive only: existing 'active' / 'retired' rows and 'auto' / 'manual' sources keep working.

alter table public.sol_learnings drop constraint if exists sol_learnings_status_check;
alter table public.sol_learnings
  add constraint sol_learnings_status_check
  check (status in ('active', 'retired', 'proposed', 'rejected'));

alter table public.sol_learnings drop constraint if exists sol_learnings_source_check;
alter table public.sol_learnings
  add constraint sol_learnings_source_check
  check (source in ('auto', 'manual', 'practice'));

create table if not exists public.sol_practice_runs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  scenario_id text not null,
  title text,
  passed boolean not null,
  failures jsonb not null default '[]'::jsonb,
  transcript jsonb not null default '[]'::jsonb,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sol_practice_runs_created on public.sol_practice_runs (created_at desc);
create index if not exists idx_sol_practice_runs_run on public.sol_practice_runs (run_id);
alter table public.sol_practice_runs enable row level security;
