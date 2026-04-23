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
