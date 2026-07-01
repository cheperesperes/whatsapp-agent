import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getBusinessMetrics } from '@/lib/business-metrics';
import { fetchAdSpend } from '@/lib/marketing/ads-insights';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

// GET /api/business/overview?days=30
// The unified business-health feed for the "Negocio" dashboard: revenue,
// profit, ad cost, traffic, the WhatsApp agent funnel, a probability-of-success
// score and data-driven suggestions. Also merges LIVE Facebook/Meta ad spend
// (which comes from the Meta API, not a table) when the ad account is configured.
export async function GET(req: NextRequest) {
  // Auth: require a logged-in dashboard user (same gate as /api/marketing/ad-spend).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(parseInt(searchParams.get('days') ?? '30', 10) || 30, 365));

  const hasMeta =
    Boolean(process.env.META_AD_ACCOUNT_ID) && Boolean(process.env.META_PAGE_ACCESS_TOKEN);

  const [metricsRes, metaRes] = await Promise.allSettled([
    getBusinessMetrics(days),
    hasMeta ? fetchAdSpend() : Promise.resolve(null),
  ]);

  if (metricsRes.status === 'rejected') {
    return NextResponse.json(
      { error: String(metricsRes.reason) },
      { status: 500, headers: NO_CACHE },
    );
  }

  return NextResponse.json(
    {
      ...metricsRes.value,
      meta_ads_live:
        metaRes.status === 'fulfilled' && metaRes.value ? metaRes.value : null,
      meta_ads_configured: hasMeta,
    },
    { headers: NO_CACHE },
  );
}
