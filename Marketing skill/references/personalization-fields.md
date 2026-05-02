# Personalization fields — three tiers

The HubSpot 2026 survey: 93% of marketers say personalization improves leads, only 13% hyper-personalize. The bottleneck is data, not technique. Sol has a structural advantage — the customer is on a 1:1 channel where the phone number joins everything.

Ship the tiers in order. Each one builds on the previous.

---

## Tier 1 — Identity (ship in week 1)

Bare-minimum personalization. Cheap, immediate, no new data engineering.

| Field | Source | Example use |
|---|---|---|
| `first_name` | `customers` table, captured from checkout / opt-in form | "Hola Eduardo, …" |
| `language` | `customers.language` (default to inbound message language detection on first contact) | Reply in matching language |
| `last_interaction_at` | `max(messages.created_at)` per `customer_id` | "Hace tiempo que no hablamos — …" if >30d |
| `customer_since` | `customers.created_at` | Recognize loyalty: "Como cliente desde 2024, …" |

**Implementation:** these get injected into the system prompt as a small `<customer_context>` block. See `scripts/personalization-prompt.ts`.

**Pitfall:** if a field is missing, omit the line — don't fall back to "Hi there" or "Hola amigo". Skipping a personalization is fine; faking one is worse than not doing it.

---

## Tier 2 — Behavior (ship in month 1)

Connect Sol's conversation log to the rest of Oiikon's data. Requires a shared `customer_id` between Luz's campaign tracking, the e-commerce side, and Sol.

| Field | Source | Example use |
|---|---|---|
| `last_purchased_product` | `orders` join | "¿Qué tal el [producto]? …" |
| `last_viewed_product` | site analytics → customer table | "Vi que estabas mirando [producto] — …" |
| `last_campaign_id` | written by outbound send | Sol knows which campaign the inbound is replying to |
| `cart_items_count` | abandoned-cart table | High-intent signal: "Dejaste algo en el carrito, ¿te ayudo a terminar?" |
| `total_lifetime_orders` | `count(orders)` | Veteran vs. first-timer tone |

**Schema requirements:** `customers.id` must be referenced by `messages`, `conversations`, `orders`, `campaigns`. If they aren't joined yet, that's the prerequisite work.

**Pitfall:** "I see you bought X last month" is delightful from a brand the customer trusts and creepy from one they don't. For Oiikon's first 1–2 months of personalization at this tier, lead with a question that lets the customer confirm rather than presenting the data as known fact: "¿Sigues usando el [producto] que compraste? Si te sirve, te puedo recomendar un complemento."

---

## Tier 3 — Predicted intent (ship in month 2–3)

A nightly Supabase view that classifies each customer into one of a small set of buckets. Sol's prompt reads the bucket and adapts tone.

Suggested buckets:

| Bucket | Definition | Sol's behavior |
|---|---|---|
| `high_intent` | Cart with items in last 48h, OR product page view + WhatsApp inbound in last 24h | Push gently to checkout, offer help, share payment link |
| `browsing` | Site activity in last 14d, no purchase in 90d | Educate, share comparisons, no pressure |
| `repeat_buyer` | 2+ orders in last 12 months | Loyalty-aware, can mention previous purchase, can upsell complements |
| `dormant` | No site activity, no purchase in 90+ days | Reactivation tone, ask what changed, soft re-engagement |
| `new` | No purchase, first 7 days since opt-in | Welcome flow, brand introduction, anchor on a single product |
| `opted_out` | `opted_out = true` | Sol does not initiate; if user re-engages, Sol confirms re-opt-in before any marketing reply |

The bucket gets injected into the prompt as a single tag (`<intent>high_intent</intent>`). The prompt has guidance for each tag.

**Implementation:** the bucket logic is a SQL view in `scripts/segmentation-queries.sql`. Refresh nightly via a Supabase scheduled function or external cron.

**Don't over-engineer.** Start with these 6 buckets. Adding a 7th and 8th has diminishing returns until each existing bucket has clear tone differences in the prompt.

---

## What NOT to personalize on

Some fields are temptingly available but bad to use directly:

- **Demographic inferences** (gender, age) when not self-reported. Sol guessing wrong is worse than not personalizing.
- **Location precision below city.** Mentioning a neighborhood is creepy unless the customer told Sol they live there.
- **Past complaint text** verbatim. Reference the issue ("about your last order") but don't quote the user back to themselves.
- **Anything from a third-party data broker.** Stick to data the customer gave Oiikon, not data Oiikon bought.

When in doubt, ask the customer. WhatsApp is a conversation channel — questions feel natural and they're free. They also produce data Oiikon owns and can prove consent for.

---

## Personalization audit cadence

Every month, run this check:

1. Pull 50 random Sol conversations.
2. For each, count personalization fields used in Sol's first reply.
3. Group by tier:
   - Tier 1 fields used: average should be 1–2 per conversation
   - Tier 2 fields used: average 0–1 (only when relevant)
   - Tier 3 bucket: present in every conversation once Tier 3 ships
4. If averages are dropping, the prompt is over-injecting and should be edited; if they're rising, more fields are being faked or hallucinated and the prompt needs tighter guardrails.
