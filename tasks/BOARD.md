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
- [ ] Live Google Ads API spend sync — needs developer token + OAuth. Until then, spend is logged manually in the Negocio board (ad_spend table).

## 🔵 In progress

<!-- Move a card here when you start it. Try to keep this short. -->
- [ ] YT Short re-edit "Se fue la luz…" (k6ZvvtlMi1Y) — analytics-driven ~20s recut + sorteo reply pack; clips rendering via Personal Clipper. Plan: docs/YT_SHORT_REEDIT_k6ZvvtlMi1Y.md (Claude)
- [x] Set up daily task organization — board + daily log + summary script (this change).

## 🟢 Done

<!-- Move finished cards here, newest first. Date them. -->
- 2026-07-04 — Cron cleanup: removed two zero-output crons (competitor-stats, comment-responder — 0 rows produced ever) and consolidated the four hourly follow-up crons into one /api/cron/followups dispatcher (same jobs, same order, per-job 50s timeout). 17 app crons → 12. Cloud routines consolidated to 2 (daily summary + corrected coach/strategist v2).
- 2026-07-02 — KB training pass: triaged the 2,324-row kb_suggestions queue (rejected 489: exact duplicates, pricing-category as policy, and clusters now covered), and added 7 canonical catalog-verified knowledge_base entries for the top repeated customer questions (payment methods, shipping regions, delivery time, E-series/F-series model comparisons). Live immediately — KB loads per message.
- 2026-07-02 — Ad-spend truth: imported June's real spend from Ads Manager CSVs into ad_spend ($604.95 = Meta $426.42 + Google $178.53; ROAS card live), and fetchAdSpend now throws on Meta API failure instead of silently reporting $0 (root cause of the fake $0 auto-sync row).
- 2026-07-02 — Judge ground truth + funnel close-link fix: sol-learning judge now grades prices/coupons against the live catalog (Pecron-mirror discounts no longer flagged as "invented"), a poisoned "never share prices" auto-learning was retired and its class is now regex-blocked, and the funnel dashboard detects the post-#290 storefront close links (7d pay-links: 1 → 5).
- 2026-07-01 — Negocio board: connected the empty feeds — live Facebook engagement + weekly FB spend auto-sync (social-stats cron) and a manual ad-spend logger (Google/WhatsApp) that activates ROAS.
- 2026-07-01 — Business dashboard ("Negocio"): unified revenue/profit, ad spend (FB/Google/WhatsApp), web traffic, Sol agent, social engagement + daily automations, probability-of-success score, auto-suggestions, and a daily snapshot cron.
- 2026-06-29 — Rebuilt 3-tier menu around in-stock heroes + generalized sizing example (#299)
- 2026-06-29 — Value-led diaspora answer; auto-return to Sol after operator text (#297, #298)
- 2026-06-28 — Close link now routes to storefront Stripe checkout; retired PayPal pay-links (#290)
- 2026-06-27 — Lean prompt rewrite (1660 → 333 lines); price-objection ladder financing-first (#278, #279)
- 2026-06-27 — Fixed inventory sync cron (UPDATE not upsert) + liveness heartbeat (#274, #275)
