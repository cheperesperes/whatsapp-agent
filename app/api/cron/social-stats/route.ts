import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { fetchPageEngagement, fetchAdSpend } from '@/lib/marketing/ads-insights';
import { fetchGoogleAdSpend, hasGoogleAds } from '@/lib/marketing/google-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Social stats + Facebook ad-spend sync
//
// Two jobs the Negocio board depends on, both driven by the Meta Graph API:
//
//   1. Facebook Page engagement (reach / reactions / comments / shares) →
//      analytics_metrics (metric_type = 'social_engagement'), one row per
//      metric per day. Fills the "Engagement social" block.
//
//   2. This week's Facebook ad spend → ad_spend (channel = 'facebook',
//      week_start = Sunday). Auto-populates the Facebook slice of the ROAS
//      calc so the owner never has to hand-log it. Google/WhatsApp spend is
//      still entered manually (no API credential for those).
//
// Both halves degrade gracefully: if the Meta env vars are missing, that half
// is skipped and reported as such — the cron still returns ok.
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

/** Sunday (UTC) of the week containing `d`, as YYYY-MM-DD — matches Meta's this_week_sun. */
function weekStartSunday(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay());
  return copy.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const sb = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const hasPage = Boolean(process.env.META_PAGE_ID) && Boolean(process.env.META_PAGE_ACCESS_TOKEN);
  const hasAdAccount = Boolean(process.env.META_AD_ACCOUNT_ID) && Boolean(process.env.META_PAGE_ACCESS_TOKEN);

  const result: Record<string, unknown> = { ok: true, date: today };

  // ── 1. Page engagement → analytics_metrics ────────────────────────────────
  if (hasPage) {
    try {
      const eng = await fetchPageEngagement(30);
      const rows = [
        ['facebook_reach', eng.reach],
        ['facebook_likes', eng.reactions],
        ['facebook_comments', eng.comments],
        ['facebook_shares', eng.shares],
      ].map(([metric_name, metric_value]) => ({
        metric_type: 'social_engagement',
        metric_name: metric_name as string,
        metric_value: Number(metric_value) || 0,
        metric_data: { window_days: 30, posts: eng.posts },
        date_recorded: today,
      }));

      // Replace today's rows so a re-run never double-counts.
      await sb
        .from('analytics_metrics')
        .delete()
        .eq('metric_type', 'social_engagement')
        .eq('date_recorded', today);
      const { error } = await sb.from('analytics_metrics').insert(rows);
      result.engagement = error ? { error: error.message } : { ...eng, rows: rows.length };
    } catch (e) {
      result.engagement = { error: String(e) };
    }
  } else {
    result.engagement = 'skipped — META_PAGE_ID / META_PAGE_ACCESS_TOKEN not set';
  }

  // ── 2. Facebook weekly spend → ad_spend ───────────────────────────────────
  if (hasAdAccount) {
    try {
      const spend = await fetchAdSpend();
      const week = weekStartSunday(new Date());
      // One canonical Facebook row per week — delete then insert.
      await sb.from('ad_spend').delete().eq('channel', 'facebook').eq('week_start', week);
      const { error } = await sb.from('ad_spend').insert({
        week_start: week,
        channel: 'facebook',
        campaign: 'Meta (auto-sync)',
        spend: spend.this_week,
        currency: spend.currency,
        note: `Auto-sincronizado desde Meta el ${today}`,
      });
      result.facebook_spend = error ? { error: error.message } : { week_start: week, spend: spend.this_week };
    } catch (e) {
      result.facebook_spend = { error: String(e) };
    }
  } else {
    result.facebook_spend = 'skipped — META_AD_ACCOUNT_ID not set';
  }

  // ── 3. Google Ads weekly spend → ad_spend ─────────────────────────────────
  if (hasGoogleAds()) {
    try {
      const g = await fetchGoogleAdSpend();
      const week = weekStartSunday(new Date());
      await sb.from('ad_spend').delete().eq('channel', 'google').eq('week_start', week);
      const { error } = await sb.from('ad_spend').insert({
        week_start: week,
        channel: 'google',
        campaign: 'Google Ads (auto-sync)',
        spend: g.this_week,
        currency: g.currency,
        note: `Auto-sincronizado desde Google el ${today}`,
      });
      result.google_spend = error ? { error: error.message } : { week_start: week, spend: g.this_week };
    } catch (e) {
      result.google_spend = { error: String(e) };
    }
  } else {
    result.google_spend = 'skipped — Google Ads env vars not set';
  }

  result.duration_ms = Date.now() - startedAt;
  return NextResponse.json(result);
}
