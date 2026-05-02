# WhatsApp Business Policy — what matters for Sol marketing

This is the short version. Read it before planning any outbound campaign.

WhatsApp is not email. The rules are stricter, the enforcement is automated, and a single bad campaign can suspend the sender for days or permanently.

---

## The 24-hour customer-service window

When a user sends Sol a message, a 24-hour window opens. During that window, Sol can send any message format (text, voice note, image, video, document) without using a pre-approved template.

When the 24-hour window closes (no inbound from that user in 24 hours), Sol can ONLY send pre-approved **template messages**, in one of three categories.

This is the single most important rule. Most marketing failures are people sending free-form messages outside the window.

**Practical implications for Sol:**
- Inside the window: Sol can be conversational, send personalized free-form replies, follow up.
- Outside the window: Sol cannot start a conversation with a free-form message. It must use a template.
- Every outbound template, if it works, re-opens the window — and *that's* when conversion happens.

Track the window per conversation. The `messages` table has `created_at` per inbound; compute `now() - max(created_at)` to know if the window is open.

---

## Template categories

Three categories, each with different rules:

### 1. Utility templates

For order updates, account notices, appointment reminders, post-purchase support — things the customer expects because they took an action.

- **Opt-in required:** general, not marketing-specific (e.g. they placed an order, they signed up).
- **Approval scrutiny:** moderate. Meta checks that the template is genuinely transactional.
- **Rate limits:** the standard tier.
- **Cost:** lowest.

**Don't:** put marketing CTAs in utility templates ("And while you're here, check out our new line!"). Meta reclassifies them on detection, and your utility volume starts counting against marketing rate caps.

### 2. Marketing templates

For promos, announcements, reactivation, anything trying to drive a new purchase.

- **Opt-in required:** explicit marketing opt-in. The customer must have agreed to receive marketing messages on WhatsApp specifically (not just signed up to a newsletter). Store this as a separate boolean: `marketing_opt_in`.
- **Approval scrutiny:** high. Templates with promotional words ("free", "act now", "limited time", "urgent", "don't miss out") frequently get rejected. Use neutral framing.
- **Rate limits:** Meta enforces per-user marketing message frequency caps. A user who's already received a marketing template recently may not be deliverable.
- **Cost:** highest.

**Don't:** send marketing templates to users with only a general opt-in. Don't send marketing templates to opted-out users — ever. Filter on `marketing_opt_in = true AND opted_out = false` before every send.

### 3. Authentication templates

OTPs and verification only. Do not use for marketing under any circumstances. Repurposing auth templates for marketing is a fast way to get the sender suspended.

---

## Quality rating

Meta tracks every WhatsApp Business sender's quality on a rolling basis. Block rate, report rate, and message volume all feed in. Quality bands:

- **Green** (high) — full message volume allowed.
- **Yellow** (medium) — flagged for review; volume may be capped.
- **Red** (low) — sender is throttled; if it stays red, the sender gets suspended.

A single sloppy campaign — wrong audience, off-brand message, missing opt-in respect — can drop the rating to yellow within hours.

**To stay green:**
- Start every new template with a small audience (50–200) and watch the read/reply/block rate before scaling.
- Pace sends — 1 message/sec to start. Burst-sending to 10k+ recipients in minutes is a quality-rating killer.
- Honor opt-outs the moment they happen. The hardening skill's STOP/BAJA flow handles this; don't bypass it.
- Personalize. Generic templates get reported; personalized templates don't.

---

## Per-user message frequency caps

Meta sets a per-user marketing message cap (varies by region, tier, and quality rating — currently in low single digits per week per user for most senders). Sol cannot tell ahead of time if a specific user has hit the cap; the API will return a delivery failure for that user only, and the rest of the send proceeds.

**Practical implication:** track delivery failures per user. If a user fails delivery on multiple campaigns in a row, mark them `do_not_message_until = now() + 7d` to avoid wasted attempts and quality hits.

---

## Opt-in capture and proof

When something goes wrong (a complaint, a Meta audit, a quality-rating drop), Oiikon needs to prove every messaged user opted in.

**Store, per opt-in:**
- `customer_id`
- `opted_in_at` (timestamp)
- `opt_in_source` (e.g. "checkout-page", "facebook-leadform", "whatsapp-double-opt-in")
- `opt_in_evidence` (URL or screenshot reference of the actual moment they opted in)

For marketing opt-ins specifically, the language at opt-in must explicitly mention WhatsApp marketing messages. Generic "we may contact you" is not enough. The wording has to say something like "I agree to receive marketing messages from Oiikon on WhatsApp."

If unsure whether a user has marketing opt-in, the safe default is utility-only.

---

## Cross-references with the hardening skill

The `whatsapp-agent-launch-hardening` skill already implements:
- STOP / BAJA / CANCELAR / CANCEL / UNSUBSCRIBE / DESUSCRIBIR opt-out keywords
- `opted_out` flag on the conversation
- Rate limit per phone (incoming abuse cap)
- Idempotency on MessageSid

This skill assumes those are in place. If they aren't, run the hardening skill before any marketing campaign.

---

## Quick checklist before any campaign send

- [ ] Segment SQL filters on `opted_out = false` AND (for marketing templates) `marketing_opt_in = true`
- [ ] Template is the right category (utility / marketing / auth) for what's actually being sent
- [ ] Template was approved by Meta (in WhatsApp Business Manager) — not in pending or rejected state
- [ ] Throttle is set (1 msg/sec default)
- [ ] First send to <200 recipients to validate quality
- [ ] Campaign ID is being written to `customers.last_campaign_id` before send so inbound replies can be attributed
- [ ] Hardening skill items (signature verification, idempotency, opt-out flow) are confirmed live in production
- [ ] KPI dashboard is set up to read the campaign within 24 hours of send

If any box is unchecked, hold the campaign.
