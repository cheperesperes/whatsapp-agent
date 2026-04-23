# Luz — Oiikon Marketing Agent

Autonomous daily marketing agent built into the Sol WhatsApp project.
Targets Hispanic market in the USA (Cuban, Venezuelan, Mexican, Dominican communities).

## What Luz does every day

```
12:00 UTC (7am EST)
  ↓
  Research — Serper searches Google for solar trends + Cuban/Hispanic Facebook groups
  ↓
  Content — Claude generates in Spanish:
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
  Learn — next day reads engagement metrics, improves content
```

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
| `GRUPOS OK` | Confirms you posted in the Facebook groups manually |

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
