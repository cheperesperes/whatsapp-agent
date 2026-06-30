# Task organization — how Claude's daily work is tracked

This folder keeps Claude's daily work organized in three plain-text files plus one
helper script. No external tools, no database — everything lives in the repo so it
travels with the code and shows up in git history.

| File | What it's for |
|------|---------------|
| [`BOARD.md`](./BOARD.md) | The task **backlog board** — what's next, what's being worked on, what's done. This is the single source of truth for *what to do*. |
| [`DAILY_LOG.md`](./DAILY_LOG.md) | The **daily work log** — a dated journal of what actually got done each day. This is the record of *what happened*. |
| [`../scripts/daily-summary.mjs`](../scripts/daily-summary.mjs) | Generates a **daily summary** from git commits and (optionally) appends it to `DAILY_LOG.md`. |

## The daily routine

1. **Start of a task** — move it to the *In progress* section of `BOARD.md` (or add it to *Backlog* first if it's new).
2. **When it's done** — move the card to *Done* in `BOARD.md`.
3. **End of the day** — run the summary to capture everything in one entry:

   ```bash
   npm run task:summary          # prints today's summary
   npm run task:summary -- --write   # also appends it to DAILY_LOG.md
   ```

   You can target any day or range:

   ```bash
   node scripts/daily-summary.mjs --since=2026-06-29 --until=2026-06-30 --write
   ```

## Auto-scheduling (run it without remembering to)

The summary is just a script, so anything that can run a command on a schedule can
run it for you. Pick whichever fits how you work:

- **Claude Code on the web (this environment) — recommended.** Ask Claude:
  *"Set up a routine that runs the daily summary every evening and emails it to me."*
  Claude will create a scheduled **Routine** (a cron-style trigger) that wakes a
  session, runs `npm run task:summary -- --write`, commits the updated log, and
  emails you the result. Nothing to install.
- **Your own machine (cron).** Add a crontab line, e.g. run at 6pm daily:

  ```cron
  0 18 * * *  cd "/path/to/whatsapp-agent" && npm run task:summary -- --write
  ```

- **GitHub Actions.** A scheduled workflow that runs the script and commits
  `DAILY_LOG.md`. Ask Claude to add `.github/workflows/daily-summary.yml` if you
  want this.

> Tip: keep `BOARD.md` accurate as you go — the daily log answers *"what changed?"*
> automatically from git, but only you/Claude can say *"what's next?"* on the board.
