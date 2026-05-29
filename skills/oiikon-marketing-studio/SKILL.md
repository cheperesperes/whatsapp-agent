---
name: oiikon-marketing-studio
description: Produce Oiikon's daily conversion-focused product ads — on-brand product IMAGES and VIDEOS (via Higgsfield) with the price + best margin-safe offer baked in, for Facebook/Instagram/YouTube. Data-driven product + scene selection. Use whenever Ed/Luz says "make a product ad", "create a marketing image/video", "promote <product> with the offer", "daily marketing post", "hypermove/product video", "generate an ad for E3800LFP/F5000LFP/E2000LFP", "build the daily marketing routine", or wants on-brand visual content that promotes a PECRON product with an offer. For the WhatsApp 1:1 channel use sol-marketing-playbook instead; for the WhatsApp offer broadcast use oiikon-marketing-offer-broadcast.
---

# Oiikon Marketing Studio

Produce daily, on-brand visual content (image + video) for Facebook/Instagram/YouTube. Output is queued for one-tap human approval — never auto-published.

## Engagement is the priority right now (grounded in the CR learning log)

Paid ads are **intentionally paused** (~through Aug 2026: trust-building, Trustpilot <15 gate), and **Facebook organic referral is the #1 real traffic source** the business has. The daily content engine went dormant 2026-05-02; restarting an *engaging* cadence is a zero-cost, high-confidence growth lever (H10, H14 in [[oiikon-cr-learning-log]]). The funnel bottleneck is **top-of-funnel** (visitor→cart, tiny traffic), not checkout.

So the goal is **build audience + engagement first, sell second.** Optimize posts for comments / shares / saves / FB-referral traffic / returning users — not just for the click. A post that earns 40 comments and 10 shares grows the free funnel more than a hard-sell ad nobody engages with.

**Content mix (default ~70/30):**
- **~70% engagement / value content** — educational, tips, myth-busting, questions/polls, community/UGC, behind-the-scenes. No offer, soft or no product push. Designed to be shared and commented on.
- **~30% offer / product content** — the image-with-offer ad units below. Use these sparingly so the feed isn't all selling.

**Engagement content library (no/low offer):**
- "How long can the {PRODUCT} run your fridge / CPAP / phone?" (concrete, answerable in comments)
- Storm-prep / outage checklist ("what to power first when the lights go out")
- Myth-busting (solar/battery misconceptions) — educational, no fear
- Poll / question ("What would you keep running in a 3-day outage?")
- Plain-language explainer (how a power station works; sizing for your home)
- Customer story / UGC / review highlight (only real ones; respects Trustpilot gate)
- Seasonal tie-in (hurricane-season readiness, winter-storm prep) — empowerment framing

**Fulfillment gate:** before pushing an *offer* on a specific SKU, confirm PECRON can fulfill it (H12 — Wesley refund). Engagement/value content has no inventory exposure, so it's always safe to run.

## Strategy (locked with Ed, 2026-05-28)

- **PECRON-first.** Promote PECRON the most for now. Other brands only on explicit request.
- **Lead angle = survival / power-outage ("never be in the dark").** This is the biggest, highest-intent, least price-sensitive US market with structural tailwinds (aging grid, 3,000+ outages/yr, storm seasons). Camping/RV is a **seasonal secondary** (summer) — bigger globally but smaller in the US, seasonal, and a price war (Jackery/EcoFlow).
- **Angle drives product (lifts AOV):**
  - Survival / outage → hero the **big units: E3800LFP ($1,199), F5000LFP ($1,999)** — "power your essentials for days."
  - Camping / RV (summer) → **E2000LFP** (proven seller) and smaller F-series.
- **Audience = all US customers, broad.** Homeowners, RVers, off-grid, preppers, small business. NOT the "familia"/Cuban-diaspora frame. Hispanic-US is one bilingual overlay, not the lead. (See memory `feedback_marketing_broad_audience`.)
- **Framing guardrail:** survival/outage = **empowerment + peace of mind** ("be ready, your home stays on"), NEVER fear-mongering, disaster-porn, or false urgency. USA-only, never mention Cuba/shipping abroad.

## Data-driven selection (run before generating)

Query Supabase project `ivgrslhhhanafcawmjjz` (service role):
1. **Top sellers / demand:** `orders` + `order_items` (units, revenue) and `marketing_performance`. Proven hero = E2000LFP; E3800LFP has warm demand.
2. **Season → scene weighting:** hurricane season Jun–Nov and winter-storm months → survival/outage heavy; summer → add camping/RV.
3. **Offer:** pick the single best **margin-safe** coupon for the chosen product per `project_sol_smart_offers` rules (`loadActiveOffers` allowlist + `selectBestOffer`: brand match + min_order + margin floor `(final-cost)/final ≥ min_margin_pct`). Validated examples: E3800LFP → **PECRON7** (~$84 off → ~$1,115); F5000LFP → **FAMILIA_F5000** ($100 off → $1,899). Never present a code that fails margin.

## Scene library (rotate, seasonal-weighted)

1. **Survival / preparedness** — calm safe interior + storm outside + tidy emergency kit; "ready for anything."
2. **Home backup / blackout** — warm living room at dusk, fridge + lamp glowing.
3. **RV / outdoor** — beside a camper van at golden hour (summer).
4. **Off-grid cabin** — wood counter, daytime, solar panel in the window.
5. **Studio hero** — seamless light-gray, premium lighting; safest (no environment to mis-render).

## Image generation (Higgsfield MCP — validated, 2 credits each)

Tool `generate_image`, model `marketing_studio_image`, `aspect_ratio:"4:5"` (feed) or `"9:16"` (stories). Pass the **real product photo as the reference**, proxied webp→JPEG (Higgsfield rejects raw .webp):
`https://wsrv.nl/?url=<supabase-host/path.webp>&output=jpg` as `medias:[{role:"image", value:<url>}]`.

**House-style prompt template** (fill `{SCENE}`):
```
Professional e-commerce marketing photo of the {PRODUCT} (match the reference
image exactly: same shape, color, screen, ports and proportions; product is the
hero, facing camera). Scene: {SCENE}. Style: high-end commercial product
photography, photorealistic, cinematic soft natural light, shallow depth of
field. Leave clean negative space in the upper third for a price/offer overlay.
REALISM RULES (strict): NO visible power cords or cables anywhere; do NOT connect
any cable to appliances; no wires from appliances; keep buttons and ports
physically plausible; natural shadows and reflections; only ONE product in frame,
no duplicates.
PHYSICAL PLAUSIBILITY (anti-"AI look"): these are HEAVY units (E2000LFP ~62 lb,
E3800LFP ~100+ lb) — place them ON THE FLOOR or a sturdy low surface (hearth,
cabinet base, truck bed, ground). NEVER on a fragile table, thin shelf, countertop
edge, or anything that couldn't hold ~100 lb. Respect real scale: the unit is
roughly knee-to-shin height next to furniture/people. Natural imperfections, real
materials, grounded contact shadows, correct proportions — not glossy/floaty CGI.
Avoid: text, watermark, extra logos, distorted hardware, floating objects.
```
**Why no cords:** AI mis-wires cables (e.g. cord from inside a fridge). Imply power with **light** (glowing appliances), forbid visible cables. This is the #1 realism fix and saves credits (kills re-rolls). **Why placement matters:** an 80–100 lb station perched on a flimsy table reads as fake instantly — keep heavy units grounded.

**Credit discipline:** preflight with `get_cost:true` (free); generate `count:1` at 1k first; only iterate the winner; one reference + one template, swap only `{SCENE}`; studio scene is the safe fallback. Poll `job_display(id)` until `completed`; use `results.rawUrl`.

## Overlays (specs + offer) — composite, don't prompt

Generate the image CLEAN (no text), then add deterministic text layers in the upper-third negative space. **Never let the image model render text** — AI text is unreliable and would misquote specs/money.

- **Spec badge (every post):** a small clean callout of the key characteristics, e.g. `3840Wh · 4200W · LiFePO4` (E3800LFP) or `1920Wh · 2000W · LiFePO4` (E2000LFP). Pull exact numbers from the product name/catalog — never invent. This is the informational anchor buyers scan for.
- **Offer badge (offer days only):** price, struck-through original, `🔥 {Y}% off`, best-offer code, CTA `oiikon.com` + WhatsApp.

Accurate specs to reuse: E2000LFP = 1920Wh / 2000W; E3800LFP = 3840Wh / 4200W; F5000LFP = 5120Wh / (check catalog). All LiFePO4.

## Video creation (Higgsfield)

Use the `hypermove-video` skill for the Higgsfield video mechanics. Marketing specifics here:
- **Format:** 9:16 vertical (Reels/Shorts/TikTok), 6–10s, product as hero.
- **Input:** start from the approved still (the generated product image) → animate with a Hyper Motion / subtle push-in so the product stays accurate; OR `generate_video` with the product image as reference.
- **Structure:** hook (1 line) → product in the day's scene → end card with price + best-offer code + CTA. Keep the same realism guardrails (no miswired cords).
- **Voice/script (if narrated):** Spanish spoken scripts must spell out acronyms (LFP→"litio", RV→"casa rodante") — see memory `feedback_ai_voice_no_acronyms`. Conversational, "tú", no specs jargon.
- **Cost:** video costs more than images — preflight `get_cost`, generate one, gate on approval before re-rolls.

## Advertising-video playbook (what actually converts, 2026)

Research-backed rules for the ad videos — apply these to every clip:

- **Hook in the first 3 seconds.** ~65% scroll away by 3s; Meta scores "Hook Rate" (3s-views ÷ impressions). Open on a *dramatic product-in-action shot or the pain point* — e.g. lights going out, then the station glowing — NOT a logo/intro. First line of caption must hit the problem immediately.
- **Length 15–30s, vertical 9:16.** Sweet spot for paid social. Retention > duration: aim **70%+ watch-through** (the metric platforms amplify). Below 30% → restructure the hook/pacing.
- **Three-act structure:** (1) 0–3s hook + problem → (2) 3–20s the solution: show the product *solving it* (fridge/lights/CPAP staying on), one concrete benefit, not a spec list → (3) last few seconds: one clear CTA (code + oiikon.com / WhatsApp).
- **Sell the transformation, not features.** "Never lose power again" beats "5120Wh LiFePO4." Specs go in the badge, not the narration.
- **Captions always** (most watch muted) — burn in short on-screen text; also our deterministic spec/offer overlay.
- **Authentic > polished for PAID conversion.** On Reels/TikTok, native/UGC-style ("looks like a friend recommending it") outperforms polished commercial by 25–40%. So: use the **cinematic Higgsfield product-motion clips for brand/organic/hero**, but for **paid-conversion** ads consider a UGC/testimonial style (real customer clip, or HeyGen talking-style) — flag to Ed which lane a given video is for.
- **Reels is the cheapest, highest-engagement Meta placement** (20–35% lower CPM, 2–3× engagement) — prioritize 9:16 Reels.
- **Test order:** hook first (drives view-through), then offer/visuals (mid-watch), then CTA (conversion). Push budget to any hook +5pp view-through over control.
- Keep all the brand/realism guardrails (no fear-mongering, no cords, USA-only, no competitor mentions).

## Daily routine (queue, never auto-publish)

Runs ~7:00am America/New_York:
1. Pull data → decide **content type by the ~70/30 mix** (most days = engagement/value; ~2 of 7 = offer). Pick product (PECRON; big-unit on survival/outage days, E2000LFP on camping days) + seasonal scene/topic.
2. Draft ES + EN post for the chosen type:
   - *Engagement day:* hook → value/question → invite comment/share → soft CTA (link only, no price push).
   - *Offer day:* hook → solution → plain-words proof → offer line → one CTA (product link + WhatsApp `wa.me/15616988477`). Confirm PECRON fulfillment first.
3. Generate the 4:5 image (house template). For offer days, composite the offer overlay; engagement days stay clean. Optionally a 9:16 video.
4. (Offer days) select the best margin-safe offer code.
5. **Queue** the draft (ES+EN text + image/video + any offer) in the marketing tab for one-tap approval. Do NOT auto-publish.

## Engagement KPIs (track weekly, not just sales)
Comments / shares / saves per post; FB-referral sessions (GA4); returning-user % (currently ~10.5% — weak, grow it); branded-search velocity (GSC); follower growth. Sales/CR are downstream — at current traffic, **growing engaged reach is the leading indicator**. Log against [[oiikon-cr-learning-log]].

## Hard rules (brand strategy, from the CR learning log)
- **Engagement-first content mix (~70/30).** Don't make every post an ad.
- USA-only; never mention Cuba or international shipping.
- **NO competitor mentions** (Jackery, EcoFlow, Bluetti, Anker, Amazon, etc.).
- **No fear-mongering / false urgency / disaster-porn.** Survival = empowerment + peace of mind.
- Broad-US audience, **not familia/diaspora-led**.
- Never quote a price/discount the catalog or `discount_codes` doesn't report; offer applied at oiikon.com checkout (authoritative gate). No `cost_price` exposure.
- **Confirm PECRON fulfillment before pushing an offer on a SKU** (H12).
- Respect the **paid-ad pause** + Trustpilot ≥15 gate; only use real reviews/UGC.
- Include WhatsApp `15616988477` (live line) + opt-out path on outbound. Bilingual ES/EN per [[project_marketing_bilingual]].

## Related
- Memory: `project_higgsfield_marketing` (Higgsfield recipe + scene library), `project_sol_smart_offers` (offer selection), `feedback_marketing_broad_audience`, `feedback_ai_voice_no_acronyms`, `project_marketing_bilingual`, `reference_oiikon_shared_db`.
- Skills: `hypermove-video` (Higgsfield video), `oiikon-marketing-offer-broadcast` (WhatsApp offer blast), `oiikon-ad-campaign-launch` (Google Pmax), `sol-marketing-playbook` (WhatsApp 1:1).
