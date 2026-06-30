# CLAUDE.md — project guide for Claude

This file is read automatically at the start of every Claude session. It tells Claude
how this project is organized and how to track daily work.

## What this project is

**Oiikon "Sol"** — a WhatsApp sales/support agent for Oiikon (USA-only solar power
stations, with a Spanish-speaking diaspora customer base).

- **Stack:** Next.js (App Router) · Supabase (database) · Anthropic SDK · Twilio (WhatsApp).
- **Hosting:** Vercel (cloud) — the app, the webhook, and all scheduled `cron` jobs run
  there 24/7. Nothing critical runs on a personal phone or PC.
- **Sol's behavior** is defined in `AGENT_PROMPT.md`. Edit there to change how Sol talks.

## Task organization — ALWAYS use this

Daily work is tracked in the [`tasks/`](./tasks/) folder. At the start and end of any
work, keep these current:

1. **[`tasks/BOARD.md`](./tasks/BOARD.md)** — the backlog board (Backlog → In progress → Done).
   - When you start a task, move/add its card to **In progress**.
   - When you finish, move it to **Done** (newest at top, with the date).
2. **[`tasks/DAILY_LOG.md`](./tasks/DAILY_LOG.md)** — the dated work journal. Generate entries with:
   ```bash
   npm run task:summary -- --write
   ```
3. For big, fully-specified task prompts, see **[`CLAUDE_CODE_PROMPTS.md`](./CLAUDE_CODE_PROMPTS.md)**.

> A scheduled cloud Routine already emails the daily summary to the owner each evening
> (6 PM ET). See [`tasks/README.md`](./tasks/README.md) for the full routine and how to
> change the schedule.

## Conventions

- **Commits:** Conventional Commits, scoped — e.g. `feat(sol): …`, `fix(sync): …`,
  `chore(tasks): …`. Keep the subject line short and customer-meaningful.
- **Changes ship via pull request**, then merge to `main` (Vercel deploys on merge).
- **Don't reintroduce retired flows** (e.g. the Cuba market — removed 2026-05-07).
  Check `CLAUDE_CODE_PROMPTS.md` before re-applying old prompts.
