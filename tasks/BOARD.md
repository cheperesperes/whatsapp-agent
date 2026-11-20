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
- [x] Set up daily task organization — board + daily log + summary script (this change).

## 🟢 Done

<!-- Move finished cards here, newest first. Date them. -->
- 2026-11-20 — Marketing queue reliability: campaign statuses `partial` (some platforms published) and `expired` (never approved, stale) now exist in the database and dashboard — `partial` was being refused by the status check, which left 11 Facebook-published campaigns stuck in "Publicando...". Before each daily generation Sol expires approvals older than 7 days and settles any campaign stuck in publishing. Queue cleaned: 180 stale approvals expired, 11 stuck set to partial.
- 2026-11-18 — Owner command `/order` (latest paid order) and `/order ORD-…`: Sol replies with the supplier-ready text. Added because the pushed message from the cron was accepted by WhatsApp but did not arrive; delivery reports are now recorded on order_supplier_notices.
- 2026-11-18 — Supplier order message: /api/cron/supplier-order-message (every 10 min) sends the operator one WhatsApp per new paid store order with the supplier-ready text (order #, model/SKU, quantity, ship-to name, address, phone; never the customer's email or the price). The owner forwards it to the supplier. One message per order (table order_supplier_notices; older paid orders pre-seeded so nothing old is sent). `?dry=1` previews.
- 2026-11-17 — Brand stock sync: TROLLEY added to the STOCK_LOCKED_SKUS default (owner set it sold out; PECRON's E3000TROLLEY feed shows it available and would flip it back). Kits (BUNDLE-*, *X2) were already skipped. Also alias F5000LFP → F5000LFP-1 (PECRON's bare-unit SKU) so its price is checked against MAP.
- 2026-11-16 — Brand stock sync respects owner decisions: /api/cron/pecron-map-audit no longer changes a product set to pre_order (E3800LFP ships late December though PECRON lists it as sellable) or a SKU in STOCK_LOCKED_SKUS (default E3600LFP: in stock with us, sold out on PECRON.com). Both still show in the digest as "stock distinto". Owner: the store database is the source of truth for stock.
- 2026-11-06 — Brand price sync, daily: /api/cron/pecron-map-audit now reads the PECRON, ECO-WORTHY and SunGold Power Shopify feeds every day (10:15 UTC), matches SKUs strictly (exact, GW- prefix, SKU token, model in our name), and auto-applies the brand price on exact matches (MAP_AUTO_APPLY=raise by default: only raises to MAP; all = also lowers; off = report only; max 15 changes per run) to products.price + agent_product_catalog.sell_price. WhatsApp digest lists the changes + remaining findings.
- 2026-10-27 — Funnel closed automatically + morning digest: /api/cron/order-conversions links every paid order to the WhatsApp conversation with the same phone (converted_at = paid_at, [CONVERSION:…] sentinel, idempotent) every 6h; /api/cron/hot-leads-digest sends the operator one WhatsApp at 12:30 UTC with the hot/warm leads scored in the last 48h (name · phone · product · last message · recommended action) plus unresolved handoffs.
- 2026-10-27 — Model upgrade: Sol replies on claude-sonnet-5-5, helpers (classifier/extraction/lead scoring/competitors) on claude-haiku-5-5, nightly review on the Sol model. All IDs now live in lib/models.ts and can be overridden on Vercel (SOL_MODEL, SOL_HELPER_MODEL, SOL_REVIEW_MODEL) — rollback without a deploy.
- 2026-10-27 — Web chat handoff + order status: a web handoff now escalates the conversation, alerts the operator on WhatsApp and shows the visitor a "Continuar por WhatsApp" button (before: Sol said "le conecto" and nothing happened). Sol answers "¿dónde está mi pedido?" herself on both channels when the customer gives an order number and it's verified (sender phone on WhatsApp / order email on web). Widget renders **bold** correctly.
- 2026-07-09 — Bundle→base stock rule: kits showing available while their power station was out (Kit Hogar 2400 → E2400LFP, Kit Hogar 5000 → F5000LFP) fixed in both the store and Sol's catalog, and the 10-min sync cron now enforces it automatically — a kit flips out of stock (inheriting the base's status) the moment its station does, on both sides. Base derived from the kit's name so new kits are covered; expansion batteries deliberately exempt.
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
