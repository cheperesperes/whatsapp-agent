# Luz — Oiikon Marketing Agent

Autonomous daily marketing agent built into the Sol WhatsApp project.

**Audience — four use-case segments** (mirrors oiikon.com's own positioning: *"Hurricane backup, home emergency power, RV and off-grid solutions"* + bilingual EN/ES support):

1. **Hurricane backup** — homeowners in FL, TX, LA, NC, PR, coastal CA prepping before storm season. Reactivates every June–November; surges before named storms.
2. **Home emergency power** — US blackout / grid-down buyers (heatwaves, wildfire PSPS shutoffs, ageing-grid states). Year-round, spikes after every regional outage.
3. **RV / overlanding** — boondockers, full-time RVers, vanlifers, weekend campers. Year-round, peaks spring–summer.
4. **Off-grid / energy savings** — cabins, tiny houses, homesteaders, solar-curious homeowners cutting bills. Slow-burn, year-round.

**Bilingual overlay across all four:** Cuban / Venezuelan / Mexican / Dominican / Puerto Rican diaspora in the US, plus Cuban MIPYMES on the Habana side who buy the same SKUs but for a different reason (apagones 8–20 h diarios). Spanish is a cultural channel, not a separate audience — the same RV / hurricane / off-grid framing translates, weighted toward "energía para tu familia en Cuba" or "lista para temporada de huracanes" depending on the buyer.

Last updated: 2026-05-02.

## What Luz does every day

```
12:00 UTC (7am EST)
  ↓
  Research — Serper searches Google across all 4 use-cases (hurricane, home emergency, RV, off-grid) + bilingual Facebook groups
  ↓
  Content — Claude generates per-segment angle (Spanish primary, English when the day's brief targets RV / hurricane US-buyers):
              • Facebook post
              • Instagram caption + hashtags
              • Google Ads (3 headlines, 2 descriptions)
              • YouTube script (60-75 sec product review)
  ↓
  Video — HeyGen creates AI avatar video in Spanish
  ↓
  WhatsApp preview → Eduardo reviews → replies SI or NO
  ↓
  Publish — Facebook · Instagram · YouTube · TikTok (all at once)
  ↓
  Group broadcast (manual or skill) — Cowork share-latest-to-all-groups
  ↓
  Learn — next day reads engagement metrics, improves content
```

## Cowork-side skills (manual companions to the autonomous loop)

The Vercel cron handles the daily generate-and-publish path. The two skills below
let Eduardo (or Luz running in Cowork mode) reach beyond the Oiikon Page itself,
into the Facebook **groups** ecosystem where the four use-case audiences (Cuba
diaspora, RV community, hurricane-prone homeowners, off-grid / energy-saving
buyers) actually buy and sell. Both live under `skills/`.

| Skill | Purpose | When to run |
|---|---|---|
| `share-latest-to-all-groups` | Broadcast the newest Oiikon Page post to every group the Oiikon Sol personal account belongs to. Walks the FB Share → Group flow, stops on rate-limit. | Mon/Wed/Fri after the daily campaign auto-publishes. ≥6-8 h between runs. |
| `discover-fb-groups` | Search FB for keywords (envíos a cuba, paqueteria, plantas eléctricas, cubanos en miami…), score each result, output `Oiikon_Groups_To_Join.xlsx` ranked S/A/B/C/D. | Tue/Thu mornings. Eduardo joins Tier S+A from the xlsx; the next broadcast picks them up automatically. |

Current footprint as of 2026-04-26: **~100 + groups joined** (57 from the original
Oiikon Sol membership + ~48 added via discover-fb-groups). Tier-S coverage:
PLANTAS ELÉCTRICAS CUBA, Planta eléctrica CUBA, Plantas Eléctricas en Cuba,
VENTAS MAYORISTAS CUBA, Ventas mayoristas para MIPYMES y TCP, MIPYMES Y TCP
COMPRAVENTAS, VENTAS MAYORISTAS A EMPRENDEDORES, Combos USA→Cuba x4, plus the
Hialeah / Miami / Florida diaspora cluster.

### Weekly cadence

| Day | Eduardo / Luz action |
|---|---|
| Mon | Auto-publish via cron → run `share-latest-to-all-groups` (skill) |
| Tue | Run `discover-fb-groups` with rotating keywords → join Tier S/A |
| Wed | Auto-publish → `share-latest-to-all-groups` (different post if available) |
| Thu | `discover-fb-groups` (different keyword set) → join more |
| Fri | Auto-publish → `share-latest-to-all-groups` |
| Sat-Sun | Read engagement, let Luz's memory absorb signals |

Three broadcasts per week is the upper safe bound for one personal FB account
without triggering anti-spam. Beyond that, FB starts limiting reach silently.

## Dashboard

URL: https://whatsapp-agent-ebon-nine.vercel.app/dashboard/marketing

Shows:
- Today's campaign status (live progress)
- Approve / Reject button (same as replying SI/NO on WhatsApp)
- Facebook Ads spend (today / week / month)
- GA4 website traffic (sessions, top pages, traffic sources)
- Campaign history with engagement scores
- Discovered Facebook groups list
- Agent memory (what themes worked, what didn't)

## Files

```
lib/marketing/
  research.ts          Web search for trends + Facebook group discovery
  content.ts           Claude generates all ad content in Spanish
  heygen.ts            HeyGen AI avatar video API
  publisher.ts         Posts to Facebook, Instagram, YouTube
  memory.ts            Agent learns from past performance
  notify.ts            WhatsApp preview to Eduardo
  db.ts                Marketing database helpers
  ads-insights.ts      Meta Ads API — spend tracking
  integrations/
    google-analytics.ts  GA4 Data API — website traffic
    tiktok.ts            TikTok Content Posting API

app/api/
  cron/marketing-daily/    Vercel cron — runs at 12:00 UTC daily
  marketing/
    heygen-webhook/         HeyGen calls this when video is ready
    approve/                Publishes on SI (WhatsApp or dashboard)
    campaigns/              Feeds the dashboard
    ad-spend/               Facebook Ads spend data
    analytics/              GA4 traffic data

app/dashboard/marketing/   Dashboard UI

skills/                          Cowork-side manual skills (Claude/Cowork mode)
  share-latest-to-all-groups/
    SKILL.md                       Walks the FB Page → Share → Group flow
  discover-fb-groups/
    SKILL.md                       FB search + scoring + xlsx ranking
    scripts/extract_groups.js      DOM extractor (run via javascript_tool)
    scripts/build_groups_to_join.py  Scoring rubric + xlsx generator

supabase/migrations/
  20260423_marketing_agent.sql   Run this first in Supabase SQL Editor
```

## Database tables (all new — never touches Sol tables)

| Table | Purpose |
|---|---|
| `marketing_campaigns` | One row per day — status, theme, product |
| `marketing_content` | Generated text + video URL + published post IDs |
| `marketing_facebook_groups` | Groups discovered by research agent |
| `marketing_performance` | Engagement fetched 24h after publishing |
| `marketing_agent_memory` | Single row — agent's learned preferences |

## Step 1 — Run migration in Supabase

1. Go to https://supabase.com → your project → SQL Editor
2. Open file: `supabase/migrations/20260423_marketing_agent.sql`
3. Paste all contents → Run
4. You should see: "Success. No rows returned."

Safe to run — all statements use `CREATE TABLE IF NOT EXISTS`.
Does not touch any existing Sol tables.

## Step 2 — Add env vars in Vercel

Go to: Vercel → whatsapp-agent-ebon-nine → Settings → Environment Variables

### Required (agent won't run without these)

```
SERPER_API_KEY
```
Get at: https://serper.dev → sign up → API Keys
Cost: ~$50/mo for 100k queries (use ~90/day)

```
HEYGEN_API_KEY
HEYGEN_AVATAR_ID
HEYGEN_VOICE_ID
```
Get at: https://heygen.com → Settings → API
- HEYGEN_AVATAR_ID: go to Avatars → pick a Spanish-speaking avatar → copy ID
- HEYGEN_VOICE_ID: go to Voices → filter Spanish → copy ID

```
META_PAGE_ID
META_PAGE_ACCESS_TOKEN
META_IG_ACCOUNT_ID
```
Get at: https://developers.facebook.com → your app → Graph API Explorer
- META_PAGE_ID: your Facebook Page ID (found in Page Settings)
- META_PAGE_ACCESS_TOKEN: generate with permissions:
    pages_manage_posts, pages_read_engagement, instagram_basic,
    instagram_content_publish, ads_read
- META_IG_ACCOUNT_ID: Instagram Business account ID linked to your Page

### For Facebook Ads spend tracking

```
META_AD_ACCOUNT_ID
```
Get at: https://adsmanager.facebook.com → top-left dropdown
Format: act_XXXXXXXXXX (include the "act_" prefix)

### For Google Analytics (GA4)

```
GA4_CLIENT_EMAIL
GA4_PRIVATE_KEY
GA4_PROPERTY_ID=518108184
```
How to get GA4_CLIENT_EMAIL and GA4_PRIVATE_KEY:
1. Go to https://console.cloud.google.com
2. Select your project → APIs & Services → Enable "Google Analytics Data API"
3. IAM & Admin → Service Accounts → Create Service Account
4. Name it: luz-marketing-agent
5. Keys → Add Key → JSON → download file
6. GA4_CLIENT_EMAIL = "client_email" value from the JSON file
7. GA4_PRIVATE_KEY = "private_key" value from the JSON file
8. In GA4 (analytics.google.com) → Admin → Account Access Management
   → Add user → paste the client_email → Viewer role

### For YouTube auto-upload

```
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
```
How to get:
1. Google Cloud Console → APIs & Services → Enable "YouTube Data API v3"
2. OAuth 2.0 Client ID → Web application
3. Use https://developers.google.com/oauthplayground to get refresh token
   → Select YouTube Data API v3 → youtube.upload scope
   → Exchange auth code for tokens → copy refresh_token

### For TikTok auto-posting

```
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_REFRESH_TOKEN
```
Get at: https://developers.tiktok.com → My Apps → create app
→ request Content Posting API access
Note: requires TikTok for Business account

## Step 3 — Merge the PR

PR: https://github.com/cheperesperes/whatsapp-agent/pull/new/feat/marketing-agent-luz

After merging, Vercel deploys automatically (~2 min).

## Step 4 — Test

1. Go to dashboard/marketing
2. Click "Generar campaña" to trigger manually
3. Watch status update: Investigando → Generando → Creando video → Listo
4. Video takes ~5-10 min (HeyGen)
5. You'll get a WhatsApp from the bot with preview
6. Reply SI to publish to all platforms

## Eduardo's WhatsApp commands (already working)

| Message | Action |
|---|---|
| `SI` | Approves and publishes the pending campaign |
| `NO` | Cancels the pending campaign |
| `GRUPOS OK` | Confirms the group broadcast (manual or skill) is complete |
| `BROADCAST` | Triggers a Cowork-side run of `share-latest-to-all-groups` (when run from a session that has Chrome MCP connected) |
| `DESCUBRIR` | Triggers a Cowork-side run of `discover-fb-groups`, returns the xlsx path |

## Security

- Dashboard requires login (admin@oiikon.com)
- All API routes return 401 if not logged in
- HeyGen webhook only updates video status (no sensitive data)
- Cron routes require CRON_SECRET header (Vercel injects automatically)
- Marketing agent NEVER reads customer conversations or profiles

## Cron schedule

| Cron | Time | What |
|---|---|---|
| marketing-daily | 12:00 UTC (7am EST) | Research + generate + submit video |

HeyGen takes 5-15 min → webhook fires → WhatsApp sent to Eduardo

## Platforms published on SI

1. Facebook Page (video post — highest organic reach)
2. Instagram Reels
3. YouTube (full video upload)
4. TikTok (same HeyGen video)

## Agent memory

After each published campaign, Luz reads engagement (likes, views, shares)
and updates its own memory table. Next day's content is influenced by:
- Which themes got high engagement
- Which themes underperformed
- Which Facebook groups were most active
- Product rotation (avoids featuring same product 2 days in a row)

Memory is stored in `marketing_agent_memory` table in Supabase.
Visible in dashboard under the Memory tab.

## Changelog

- **2026-04-26** — Added Cowork-side skills `share-latest-to-all-groups` and `discover-fb-groups`. Joined ~48 net-new groups across envíos / paquetería / cubanos-en-miami / plantas-eléctricas searches. Total Oiikon Sol group footprint now ~105. Updated daily flow and weekly cadence sections. Added `BROADCAST` and `DESCUBRIR` WhatsApp triggers (planned).
- **2026-04-23** — Initial Luz autonomous loop deployed to Vercel. Daily cron + HeyGen + dashboard online.
