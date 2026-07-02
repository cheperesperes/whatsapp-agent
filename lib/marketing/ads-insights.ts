const META_API = 'https://graph.facebook.com/v21.0';

export interface AdSpend {
  today: number;
  yesterday: number;
  this_week: number;
  this_month: number;
  currency: string;
}

export interface CampaignSpend {
  id: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  cpc: number;   // cost per click
  cpm: number;   // cost per 1000 impressions
  ctr: number;   // click-through rate %
  daily_budget: number | null;
  lifetime_budget: number | null;
}

interface MetaInsightRow {
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
}

interface MetaCampaignRow {
  id: string;
  name: string;
  status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  insights?: { data: MetaInsightRow[] };
}

function n(val?: string): number {
  return val ? parseFloat(val) : 0;
}

async function metaGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${META_API}${path}&access_token=${token}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta API error (${res.status}): ${err.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchAdSpend(): Promise<AdSpend> {
  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!accountId || !token) throw new Error('META_AD_ACCOUNT_ID or META_PAGE_ACCESS_TOKEN not set');

  const presets = ['today', 'yesterday', 'this_week_sun_today', 'this_month'] as const;

  const results = await Promise.allSettled(
    presets.map((preset) =>
      metaGet(
        `/act_${accountId}/insights?fields=spend,account_currency&date_preset=${preset}`,
        token
      )
    )
  );

  // A failed insights call is an ERROR, never $0 — mapping rejections to zero
  // spend made the weekly ad_spend sync silently log $0 while campaigns were
  // live (real incident 2026-07-02: token/permission failure → fake $0 row).
  // Every caller already handles a throw (allSettled or try/catch), so the
  // error surfaces in the cron result / spend_error instead of fake numbers.
  const failures = presets
    .map((p, i) => {
      const r = results[i];
      return r.status === 'rejected'
        ? `${p}: ${(r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 180)}`
        : null;
    })
    .filter((f): f is string => f !== null);
  if (failures.length > 0) {
    throw new Error(`Meta insights failed (${failures.length}/${presets.length}): ${failures.join(' · ')}`);
  }

  const extract = (r: PromiseSettledResult<unknown>): { spend: number; currency: string } => {
    if (r.status !== 'fulfilled') return { spend: 0, currency: 'USD' };
    const data = (r.value as { data?: MetaInsightRow[]; account_currency?: string }).data ?? [];
    const currency = (r.value as { account_currency?: string }).account_currency ?? 'USD';
    const spend = data.reduce((sum, row) => sum + n(row.spend), 0);
    return { spend, currency };
  };

  const [today, yesterday, week, month] = results.map(extract);

  return {
    today: today.spend,
    yesterday: yesterday.spend,
    this_week: week.spend,
    this_month: month.spend,
    currency: today.currency,
  };
}

// ── Facebook Page engagement ────────────────────────────────
// Aggregate reach/reactions/comments/shares across the Page's recent posts.
// Uses the Page ID + Page access token (needs pages_read_engagement /
// read_insights). Powers the "Engagement social" block on the Negocio board.

export interface PageEngagement {
  reach: number;
  reactions: number;
  comments: number;
  shares: number;
  posts: number;
}

interface PostRow {
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  insights?: { data?: { values?: { value?: number }[] }[] };
}

export async function fetchPageEngagement(days = 30): Promise<PageEngagement> {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) throw new Error('META_PAGE_ID or META_PAGE_ACCESS_TOKEN not set');

  const since = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const fields = [
    'shares',
    'reactions.summary(total_count)',
    'comments.summary(total_count)',
    'insights.metric(post_impressions_unique)',
  ].join(',');

  const data = (await metaGet(
    `/${pageId}/posts?fields=${fields}&since=${since}&limit=50`,
    token,
  )) as { data?: PostRow[] };

  const posts = data.data ?? [];
  let reach = 0, reactions = 0, comments = 0, shares = 0;
  for (const p of posts) {
    shares += p.shares?.count ?? 0;
    reactions += p.reactions?.summary?.total_count ?? 0;
    comments += p.comments?.summary?.total_count ?? 0;
    reach += p.insights?.data?.[0]?.values?.[0]?.value ?? 0;
  }
  return { reach, reactions, comments, shares, posts: posts.length };
}

export async function fetchCampaignBreakdown(): Promise<CampaignSpend[]> {
  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!accountId || !token) throw new Error('META_AD_ACCOUNT_ID or META_PAGE_ACCESS_TOKEN not set');

  const fields = [
    'name', 'status', 'daily_budget', 'lifetime_budget',
    'insights.date_preset(last_30d){spend,impressions,clicks,reach,cpc,cpm,ctr}',
  ].join(',');

  const data = (await metaGet(
    `/act_${accountId}/campaigns?fields=${fields}&limit=20`,
    token
  )) as { data?: MetaCampaignRow[] };

  return (data.data ?? []).map((c) => {
    const insight = c.insights?.data?.[0] ?? {};
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      spend: n(insight.spend),
      impressions: n(insight.impressions),
      clicks: n(insight.clicks),
      reach: n(insight.reach),
      cpc: n(insight.cpc),
      cpm: n(insight.cpm),
      ctr: n(insight.ctr),
      daily_budget: c.daily_budget ? n(c.daily_budget) / 100 : null,
      lifetime_budget: c.lifetime_budget ? n(c.lifetime_budget) / 100 : null,
    };
  });
}
