# Claude Code prompts — Oiikon Sol WhatsApp Agent

Ready-to-paste prompts for future Claude Code sessions. Open a terminal in this repo (`cd "/Users/almiraspropertymanagementllc/Whatsapp Agent" && claude`) and paste whichever prompt matches the task.

**Last updated:** 2026-05-07 — Cuba market removed; Sol now USA-only across prompt + widget + Luz.

---

## TASK 1 — RETIRED (was: Sol prompt fixes for Cuba market tuning)

The original TASK 1 contained 4 critical bugs + 6 optimizations focused on tuning Sol's Cuba diaspora flow (E1000 → E2400 substitution, E3800 catalog, panel upsell at commitment for Cuba, E2400 as Cuba default, "Cuba shipping timeline" specificity, etc.).

**Why it was retired:** As of 2026-05-07 Oiikon stopped shipping to Cuba and shifted to USA-only. The Cuba sales flow, Cuba pricing tracks, SCP §740.21 / OFAC mentions, province/CI capture, and Cuba diaspora positioning were removed from `AGENT_PROMPT.md`, `public/widget.js`, `lib/marketing/content.ts`, and `lib/marketing/research.ts` in the same session. Re-tuning a flow that no longer exists would undo the cleanup.

**If you need a record of the retired prompt** (for historical context — e.g. understanding the sales playbook that was running through 2026-04 to track LTV against pre-transition cohorts), it lives in git history at the commit immediately before this file was rewritten. Use `git log CLAUDE_CODE_PROMPTS.md` to find it.

**Do NOT re-apply the retired prompt.** It will reintroduce Cuba shipping copy.

---

## TASK 2 — GCLID / FBCLID attribution system

**Impact:** Unlocks Meta CAPI + Google Ads offline conversion tracking → measurable ROAS → scale ads from $20/day to $100-500/day with confidence.
**Effort:** 3-4 hours across migration + webhook + action route (excluding OAuth setup which requires manual operator steps).
**Risk:** Medium — touches production webhook. Must preserve Twilio signature verification, idempotency, rate limiting.
**Prerequisite:** 10+ sales marked "venta ganada" in dashboard (build the habit first).

### Context

Site already captures attribution: `src/App.jsx` on oiikon.com has a JS handler that reads `gclid`, `fbclid`, `utm_*` from URL and embeds them in `wa.me/` prefill message as `[GCLID:xxx|FBCLID:yyy|SRC:facebook|MED:cpc|CMP:pecron-e2400]`.

Meta CTWA ads ALSO pass referral metadata via Twilio webhook body params: `ReferralSourceId`, `ReferralSourceType`, `ReferralHeadline`, `ReferralBody`, `ReferralCTWAClid`. Both paths need to be captured.

### The prompt — paste this into Claude Code

```
Hi Claude. I'm working on the Oiikon WhatsApp Agent (Sol). We need to build Meta/Google Ads conversion attribution so when a WhatsApp lead closes as a sale, we can tell Meta/Google which ad drove it. This unlocks ROAS tracking and scalable ads spend.

Context on current infra:
- Next.js app on Vercel
- Supabase (ivgrslhhhanafcawmjjz) stores conversations + messages + customer_profiles
- Twilio webhook processes inbound WhatsApp messages at app/api/webhook/route.ts
- Dashboard has a "Marcar como venta ganada" button that calls app/api/conversations/[id]/action/route.ts with marks converted_at on the conversations table

Current gaps:
- No GCLID (Google Ads) or FBCLID (Facebook/Meta) captured from first message
- When conversion fires, no upload back to Meta Conversions API or Google Ads offline conversions
- Attribution chain is broken: ad click → WhatsApp msg → sale is invisible to Meta/Google

Your task — build this in 4 phases, ask me before starting each phase:

PHASE 1 — SCHEMA CHANGES (Supabase migrations)
Create migration file supabase/migrations/<timestamp>_add_ads_attribution.sql:

```sql
-- Attribution columns on conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS gclid TEXT,
  ADD COLUMN IF NOT EXISTS fbclid TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,
  ADD COLUMN IF NOT EXISTS utm_source TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_content TEXT,
  ADD COLUMN IF NOT EXISTS landing_page TEXT,
  ADD COLUMN IF NOT EXISTS attribution_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_gclid ON conversations(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_fbclid ON conversations(fbclid) WHERE fbclid IS NOT NULL;

-- Conversions queue (upload later via cron)
CREATE TABLE IF NOT EXISTS ads_conversion_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('google_ads', 'meta_capi')),
  click_id TEXT NOT NULL,
  conversion_value_usd NUMERIC(10,2),
  conversion_currency TEXT DEFAULT 'USD',
  conversion_event_name TEXT DEFAULT 'Purchase',
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'failed', 'skipped')),
  upload_attempted_at TIMESTAMPTZ,
  upload_response JSONB,
  upload_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_conv_queue_status ON ads_conversion_queue(status, created_at);
```

PHASE 2 — CAPTURE ATTRIBUTION ON FIRST MESSAGE
Modify app/api/webhook/route.ts:
1. After loading the conversation and BEFORE calling Sol/Claude, check if this is the customer's FIRST message (message_count <= 1)
2. If first message, parse attribution tags from message body using this regex: /\[(?:GCLID|FBCLID|CTWA_CLID|SRC|MED|CMP|CONTENT|LAND)[^\]]*\]/
3. Also check Meta's CTWA metadata — Twilio may include `ReferralSourceId`, `ReferralSourceType`, `ReferralHeadline`, `ReferralBody`, `ReferralCTWAClid` in the webhook payload body params
4. Parse and write gclid, fbclid, ctwa_clid, utm_* fields to the conversations table
5. Strip the `[...]` tag from the message before storing in messages table (so Sol doesn't see it)
6. Log captures to console

Create lib/attribution.ts with:
- parseAttributionTag(text) → returns { gclid?, fbclid?, utm_* } or null
- stripAttributionTag(text) → returns clean message
- extractCTWAMetadata(twilioBody) → returns Meta referral data if present
- upsertConversationAttribution(supabase, conversationId, attribution) → updates row

PHASE 3 — QUEUE CONVERSION ON /won
Modify app/api/conversations/[id]/action/route.ts:
1. When action is 'won' (venta ganada), after the existing UPDATE that sets converted_at:
2. Check if conversation has gclid → INSERT into ads_conversion_queue with platform='google_ads', click_id=gclid
3. Check if conversation has fbclid OR ctwa_clid → INSERT with platform='meta_capi', click_id=fbclid or ctwa_clid
4. Accept optional conversion_value_usd in the request body (so operator can input sale amount when marking won)

DO NOT yet build the actual upload script to Google Ads / Meta APIs — that's Phase 4 and requires OAuth setup the operator hasn't done yet.

PHASE 4 — UPLOAD SCRIPTS (build only if operator says to proceed)
Create scripts/upload-ads-conversions.ts (Deno/TypeScript):
- Poll pending rows from ads_conversion_queue
- For google_ads: POST to https://googleads.googleapis.com/v18/customers/{customer_id}:uploadClickConversions
- For meta_capi: POST to https://graph.facebook.com/v18.0/{pixel_id}/events with click_id in user_data
- Update row with status='uploaded' + upload_response, or 'failed' + upload_error
- Batch in groups of 50

Create GOOGLE_ADS_META_INTEGRATION.md documenting required env vars:
- GOOGLE_ADS_DEVELOPER_TOKEN
- GOOGLE_ADS_CUSTOMER_ID (no hyphens)
- GOOGLE_ADS_LOGIN_CUSTOMER_ID (MCC, if applicable)
- GOOGLE_ADS_CONVERSION_ACTION_ID
- GOOGLE_ADS_OAUTH_CLIENT_ID
- GOOGLE_ADS_OAUTH_CLIENT_SECRET
- GOOGLE_ADS_OAUTH_REFRESH_TOKEN
- META_PIXEL_ID
- META_CAPI_ACCESS_TOKEN (system user token)

Then add Vercel cron in vercel.json to run the upload script every 4 hours.

CONSTRAINTS:
- Do NOT modify Sol's system prompt (AGENT_PROMPT.md) or any Claude API call
- Do NOT break existing Twilio signature verification, idempotency, or rate limiting
- Do NOT change dashboard UI except adding an optional "sale amount" input when clicking "venta ganada"
- Parse attribution ONLY on first message of new conversations, not every message
- If parsing fails, continue normal flow silently
- Log everything for debugging

Start with Phase 1. Show me the migration file before applying.
```

---

## Context you may need during a session

### Live performance metrics (as of 2026-04-23, pre-transition)
- 80 total conversations, 79 active
- 54 new conversations in last 7 days
- 504 messages in last 7 days
- 0% escalation rate (Sol fully autonomous)
- 0 "venta ganada" marks (operator has NOT been marking — user priority)

> Note: as of 2026-05-07 Cuba market is closed; metrics will trend down then recover with USA-only ad spend. Compare cohorts pre/post 2026-05-07 carefully.

### Current inventory snapshot (as of 2026-04-23)
- **E1000 LFP:** see live catalog
- **E2400 LFP:** ad hero product, $629 MAP
- **E3600 LFP:** best-seller
- **E3800 LFP:** ad hero (premium), $1,199
- **F3000 LFP:** in stock
- **F1000 LFP:** in stock
- **PV200 solar panel:** $99 retail, 24% margin
- **PV300 solar panel:** $299 retail, 33% margin ⭐
- **Waaree 570W solar panel:** $145 retail (cheaper + double wattage of PV200)

(Authoritative inventory lives in Supabase `products` table — check there for live numbers.)

### Dropshipper margins (for reference when Sol negotiates)
- E1500LFP: $399 cost / $469 MAP / $70 margin (17.5%)
- E2400LFP: $472 cost / $629 MAP / $157 margin (33%) ⭐
- E3600LFP: $839 cost / $1,049 MAP / $210 margin (25%)
- E3800LFP: $960 cost / $1,199 MAP / $239 margin (25%)
- F1000LFP: $264 cost / $329 MAP / $65 margin (25%)
- F3000LFP: $679 cost / $799 MAP / $120 margin (18%)

### Shipping (USA only, 2026-05-07 onward)
- Free shipping to the 48 contiguous states.
- Alaska, Hawaii, Puerto Rico: specialist quote (`[HANDOFF: shipping to AK/HI/PR]`).
- International: **discontinued** as of 2026-05-07. Sol uses the polite-decline plantilla in `AGENT_PROMPT.md`.

> The legacy international shipping formula (`weight_lbs × $1.99 + handling_tier_fee`) and tier table are no longer used for new orders. They survive in `shipping_settings` / `shipping_handling_tiers` for historical orders only.

### Memory reference
Marketing context file at:
`~/.claude/projects/-Users-almiraspropertymanagementllc-Downloads-horizons-export-Oiikon/memory/`
