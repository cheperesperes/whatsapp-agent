---
name: sol-marketing-playbook
description: Design, build, and iterate Oiikon's Sol WhatsApp agent as a marketing channel — define brand POV, personalize replies from Supabase customer data, plan and ship outbound template campaigns, and track conversation-level KPIs. Applies HubSpot's Loop Marketing framework (Express → Tailor → Amplify → Evolve) to the WhatsApp 1:1 channel, with WhatsApp Business policy compliance baked in. Use whenever Eduardo or Luz says "Sol sounds too generic", "let's run a WhatsApp campaign", "personalize replies for high-intent users", "Sol's brand voice", "send a broadcast to <segment>", "what's converting on WhatsApp", or wants to audit/improve any part of Sol's outbound or inbound marketing. Also use when designing a new Meta WhatsApp template, segmenting customers in Supabase for messaging, wiring marketing KPIs into the dashboard, or handing off Luz's daily campaigns to Sol on WhatsApp.
---

# Sol Marketing Playbook

## Purpose

Sol is Oiikon's WhatsApp agent. WhatsApp is the channel where high-intent visitors arrive — already pre-qualified by AI search, social, and Luz's daily campaigns — and where conversion either happens or doesn't. This skill is the playbook for making Sol a strong marketing channel without breaking WhatsApp Business policy or Oiikon's brand voice.

## Audience — four use-case pillars + bilingual overlay

Oiikon's site self-describes as serving *"Hurricane backup, home emergency power, RV and off-grid solutions"* with bilingual EN/ES support. Sol must speak to all four use cases, not just the Cuban diaspora frame:

1. **Hurricane backup** — FL, TX, LA, NC, PR, coastal CA homeowners. Seasonal: ramp in May, peak June–November, drop after.
2. **Home emergency power** — US blackout / grid-down buyers nationwide. Year-round, surges after any regional outage.
3. **RV / overlanding** — boondockers, full-timers, vanlifers, weekenders. Year-round, peaks spring–summer.
4. **Off-grid / energy savings** — cabins, tiny houses, homesteaders, solar-curious bill-reducers. Slow-burn, year-round.

**Bilingual overlay:** Cuban / Venezuelan / Mexican / Dominican / Puerto Rican diaspora in the US, plus Cuban MIPYMES on the Habana side. Spanish is a cultural channel, not a separate use-case — the same four pillars translate, just weighted toward "energía para tu familia en Cuba" or "lista para temporada de huracanes" depending on the buyer.

Tag every customer with a `use_case` value so Sol and the campaign runner can pick the right tone, the right season, and the right cooldown. Never pitch hurricane prep to an RV buyer in February — it just trains opt-outs.

The structure follows HubSpot's Loop Marketing framework, adapted for a WhatsApp 1:1 channel:

1. **Express** — Define and enforce Oiikon's brand POV in every reply. Generic AI output is the failure mode; brand POV is the moat.
2. **Tailor** — Pull customer data from Supabase (shopping habits, interests, purchase history — the three most valuable per the 2026 HubSpot survey) and inject it into Sol's prompts and outbound templates.
3. **Amplify** — Run outbound campaigns within WhatsApp Business policy: opt-in templates, the 24-hour customer-service window, throttling, and segmentation. Connect to Luz's content engine so WhatsApp is a *conversion* channel, not a discovery one.
4. **Evolve** — Track conversation-level KPIs in Supabase (lead quality, lead-to-customer, CAC, response time) and feed the insights back into the brand POV, prompt, and segmentation.

## When to use

Trigger this skill when Eduardo or Luz wants to work on any part of Sol's marketing — brand voice, replies, personalization, outbound campaigns, KPIs, opt-in flows, or template approval. Specific cues: "Sol sounds bland", "let's broadcast a promo", "segment our customers", "what should we measure", "approve a marketing template", "Luz's campaign should hand off to Sol on WhatsApp", "why is conversion dropping".

Do NOT use this skill for:
- Production hardening (signature verification, RLS, idempotency) → use `whatsapp-agent-launch-hardening`
- Facebook group broadcasting → use `share-latest-to-all-groups`
- Pure dev work unrelated to marketing (refactors, infra, debugging non-marketing features)

## The four phases — work them in order, then iterate

The phases are sequenced because each one requires the previous: you can't tailor without an expressed POV, can't amplify without tailoring, can't evolve without amplifying. But once all four are running, the loop iterates — every campaign and every conversation feeds the next round.

If Eduardo or Luz asks for help with one specific phase, jump straight to it. Don't force them to redo earlier phases unless something in those phases is genuinely broken.

### Phase 1 — Express (brand POV)

The HubSpot 2026 survey found 40% of teams haven't documented their unique value proposition. Oiikon should not be in that 40%. Without a documented POV, every Sol reply is one bad prompt away from sounding like every other AI agent.

**Deliverable:** a `BRAND_POV.md` committed at the repo root. Use `references/brand-pov-worksheet.md` as the structure. The five sections that matter:

1. **What Oiikon believes** that competitors don't (3–5 bullets, sharp opinions, not platitudes).
2. **The customer in Oiikon's words** — language the customer actually uses, not corporate-speak.
3. **Tone rules** — formal/informal, emoji policy, voice-note policy, length, response cadence.
4. **What Sol never does** — avoid words/phrases (e.g. "I'm an AI assistant", "As a language model", anything that breaks the persona).
5. **Anchor examples** — 5+ actual sample exchanges, written by a human, that show Sol-sounding-like-Sol. These go into Sol's system prompt as few-shot examples.

Once `BRAND_POV.md` exists, wire it into Sol's system prompt. The prompt-builder pattern is in `scripts/personalization-prompt.ts`.

**Do not write the POV with the LLM.** Interview Eduardo and Luz, then transcribe. The whole point is that it's *Oiikon's* POV. If `BRAND_POV.md` reads like an LLM wrote it, Sol will sound like an LLM.

**Audit check:** read 20 random Sol conversations from Supabase. For each, ask: "could a competitor have sent this exact reply?" If yes for >5 of them, the POV isn't strong enough yet — sharpen the differentiators in `BRAND_POV.md` and re-run.

### Phase 2 — Tailor (personalization from Supabase)

93% of marketers report personalization improves leads or purchases, yet only 13% hyper-personalize. The bottleneck is data access, not technique — the survey found 44% of teams know shopping habits, 39% know demographics, 31% know purchase history. Sol's advantage: the customer is on a 1:1 channel where their phone number is the join key to everything Oiikon knows about them.

Three tiers of personalization. Ship them in order:

1. **Identity** (cheap, immediate) — name, language preference, last interaction date. Inject into the system prompt before every LLM call.
2. **Behavior** (medium effort) — last products viewed, last purchase, last campaign clicked. This requires Luz's campaign tracking and Sol's conversation logging to share a `customer_id`.
3. **Predicted intent** (higher effort, highest payoff) — high-intent / browsing / dormant / opted-out. Computed nightly from a Supabase view; injected as a single tag into the prompt so Sol can adapt tone (high-intent → push to checkout, browsing → educate, dormant → reactivation offer).

Field-by-field guidance is in `references/personalization-fields.md`. The prompt-injection pattern is in `scripts/personalization-prompt.ts`. The example segment SQL is in `scripts/segmentation-queries.sql`.

Personalization data must respect RLS — Sol's webhook reads via the service role, but any admin UI must be authenticated and scoped. Piggyback on the RLS audit from `whatsapp-agent-launch-hardening`; don't re-implement it.

**Conservative rule:** don't personalize with data the customer hasn't given Oiikon on this channel without thinking about it first. "Saw you bought X last month" is great if the customer expects Oiikon to remember; it's creepy if it came from a list they forgot they were on. When in doubt, lead with a question that lets them confirm.

### Phase 3 — Amplify (outbound campaigns)

Inbound is necessary but not sufficient. Outbound campaigns let Sol move customers along the journey instead of waiting for them to come back. But WhatsApp Business policy is strict, and the cost of getting it wrong is sender suspension. **Read `references/whatsapp-message-policy.md` before planning any outbound** — it's short and the rules bite hard.

Outbound campaign workflow:

1. **Define the segment.** A typed Supabase query (PostgREST `from(...).select()` or a named, parameterized RPC) that returns the recipients with their personalization fields. Examples in `scripts/segmentation-queries.sql`. Do NOT pass a raw SQL string into the campaign runner — segments must be named, typed, and reviewable.
2. **Confirm opt-in.** Filter out anyone where `opted_out = true` (set by the STOP/BAJA flow from the hardening skill). For marketing templates, also require an explicit marketing opt-in field — utility templates don't, marketing templates do.
3. **Pick the right template category.**
   - **Utility** — order updates, account notices. Lower scrutiny, no marketing opt-in required, but content must genuinely be utility.
   - **Marketing** — promos, announcements, reactivation. Stricter approval, requires explicit marketing opt-in, subject to per-user rate caps from Meta.
   - **Authentication** — OTPs only. Do not use for marketing.
4. **Submit the template for Meta approval.** Templates are approved through WhatsApp Business Manager (Meta directly — no Twilio in the path). Templates with one-shot personalization variables (`{{1}}`, `{{2}}`) get approved fastest. Avoid promotional language that triggers rejection ("free", "act now", "limited time" — Meta's classifier flags these). The send-payload shape is in `scripts/outbound-campaign.ts`.
5. **Dry-run, then throttle the send.** Run `runCampaign({ ...input, dryRun: true })` first — it returns the audience size, sample body params, and estimated cost without making any Meta Graph call or DB write. Confirm the numbers with Eduardo or Luz before re-running without the flag. Real sends pace at 1 message/sec per sender; the loop aborts after 5 consecutive 5xx from Graph and tags `last_campaign_id` per-successful-send (not in bulk) so an aborted run doesn't pollute attribution. The send loop is in `scripts/outbound-campaign.ts`.
6. **Hand off to Sol's inbound flow.** Every outbound message must invite a reply, and replies open the 24-hour customer-service window — that's where conversion happens. Make sure the inbound flow knows which campaign the user is replying to (write a `last_campaign_id` to the customer record before send, read it on inbound).

Default to small campaigns (50–200 recipients) for the first month while quality-rating builds. Meta tracks sender quality; a single big spammy send tanks it.

### Phase 4 — Evolve (KPIs and the loop)

73% of marketers implement campaign changes within days or hours. Sol can do better — the Supabase log of every conversation is a real-time evaluation set. The KPIs from the HubSpot 2026 survey that matter most for a WhatsApp agent:

| KPI | What it means for Sol | Source |
|---|---|---|
| Lead quality / MQLs | Conversations that show buying intent | Classifier or keyword match on inbound, written to `conversations.intent_score` |
| Lead-to-customer conversion | % of inbound conversations that result in a purchase within 7d | Join `conversations` ↔ `orders` on `customer_id` |
| WhatsApp CAC | (Meta conversation cost + LLM cost) ÷ customers acquired in window | Meta marketing-conversation cost + Anthropic token cost per conversation |
| Response time | Median seconds from inbound → first reply | `replies.created_at - messages.created_at` |
| Per-campaign ROI | Revenue attributed ÷ campaign cost | Campaign ID injected at outbound, joined to orders on `customer_id` |

Schema migrations and queries are in `scripts/conversation-outcomes.sql`. Full definitions are in `references/kpi-definitions.md`. Build a dashboard query for each. Review weekly (the survey median); review daily during a campaign launch.

The loop closes here. Each weekly review feeds back into:
- **Phase 1** — POV updates if a tone is underperforming
- **Phase 2** — new personalization fields if a high-intent segment is being missed
- **Phase 3** — segment refinement, template tweaks, throttle adjustments

Don't measure short-term lift only. A campaign that boosts week-1 conversion but spikes opt-outs is net-negative. Track 30-day retention alongside immediate response rates.

## Bundled resources

- `references/brand-pov-worksheet.md` — the structure for `BRAND_POV.md`. Fill in with Eduardo and Luz; don't write it for them.
- `references/personalization-fields.md` — the three tiers of personalization data and what each enables.
- `references/whatsapp-message-policy.md` — the parts of WhatsApp Business policy that matter for marketing: 24h window, template categories, opt-in rules, quality rating.
- `references/kpi-definitions.md` — KPI definitions, formulas, and example dashboard queries.
- `scripts/segmentation-queries.sql` — Supabase queries for high-intent, browsing, dormant, repeat-buyer, and abandoned-cart segments.
- `scripts/conversation-outcomes.sql` — schema migrations for tracking conversation intent, outcomes, and campaign attribution.
- `scripts/personalization-prompt.ts` — pattern for building Sol's system prompt with brand POV + customer context injected.
- `scripts/outbound-campaign.ts` — Meta WhatsApp Cloud API template send loop with dry-run, throttling, opt-out respect, per-success attribution, and Meta error-code handling.

## Anti-patterns to avoid

- **Don't write the brand POV with the LLM.** It must come from Eduardo and Luz. The LLM can interview, transcribe, and tighten — but not invent.
- **Don't run an outbound campaign before the opt-out flow is verified end-to-end.** Marketing to opted-out users is a ban-level offense in WhatsApp Business policy and a trust-level offense with the user.
- **Don't put marketing language in utility templates.** Meta will reclassify them, and your utility-message volume will start counting against your marketing rate cap.
- **Don't measure short-term lift only.** Pair every immediate-response metric with a 30-day retention metric so you catch campaigns that buy lift with churn.
- **Don't conflate brand POV with the system prompt.** The POV is the *what* (a human-readable doc Eduardo and Luz own); the prompt is the *how* (the engineered string Sol consumes). Edit them in different files for different reasons.
- **Don't optimize on opinion.** Every change to the POV, prompt, segmentation, or template gets logged with a date and a hypothesis, so the weekly review can tell what moved the needle.

## Why this matters

The HubSpot 2026 survey's headline finding is that AI made marketing more human, not less. Sol is on the most human channel Oiikon has — a 1:1 thread on a phone. The agent that gets brand POV, personalization, and the 24-hour window right will convert dramatically better than one that pumps out generic templates, because every single Sol conversation is either building Oiikon's brand or eroding it. There is no neutral message.
