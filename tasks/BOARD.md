# Task board — Oiikon Sol WhatsApp Agent

Single source of truth for **what to do next**. Move cards between sections as work
progresses: `Backlog → In progress → Done`. Keep the newest *Done* items at the top.

For ready-to-paste, fully-specified task prompts (the big multi-phase ones), see
[`../CLAUDE_CODE_PROMPTS.md`](../CLAUDE_CODE_PROMPTS.md). This board is the lightweight
day-to-day tracker that points at those when needed.

**Card format:** `- [ ] <short title> — <one-line context> (owner, optional #issue/PR)`

---

## 🟡 Backlog (next up)

<!-- Add new tasks here. Most important at the top. -->
- [ ] GCLID/FBCLID attribution system — Meta CAPI + Google Ads offline conversions. Full spec in CLAUDE_CODE_PROMPTS.md → TASK 2. Prereq: 10+ "venta ganada" marked first.

## 🔵 In progress

<!-- Move a card here when you start it. Try to keep this short. -->
- [x] Set up daily task organization — board + daily log + summary script (this change).

## 🟢 Done

<!-- Move finished cards here, newest first. Date them. -->
- 2026-07-02 — Live Google Ads spend sync (google-ads.ts + social-stats cron) — auto-logs weekly Google spend into ad_spend like Facebook; board shows live Google spend. Needs GOOGLE_ADS_* env vars.
- 2026-07-01 — Negocio board: connected the empty feeds — live Facebook engagement + weekly FB spend auto-sync (social-stats cron) and a manual ad-spend logger (Google/WhatsApp) that activates ROAS.
- 2026-07-01 — Business dashboard ("Negocio"): unified revenue/profit, ad spend (FB/Google/WhatsApp), web traffic, Sol agent, social engagement + daily automations, probability-of-success score, auto-suggestions, and a daily snapshot cron.
- 2026-06-29 — Rebuilt 3-tier menu around in-stock heroes + generalized sizing example (#299)
- 2026-06-29 — Value-led diaspora answer; auto-return to Sol after operator text (#297, #298)
- 2026-06-28 — Close link now routes to storefront Stripe checkout; retired PayPal pay-links (#290)
- 2026-06-27 — Lean prompt rewrite (1660 → 333 lines); price-objection ladder financing-first (#278, #279)
- 2026-06-27 — Fixed inventory sync cron (UPDATE not upsert) + liveness heartbeat (#274, #275)
