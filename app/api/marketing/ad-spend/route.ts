import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { fetchAdSpend, fetchCampaignBreakdown } from '@/lib/marketing/ads-insights';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const hasAdAccount =
    Boolean(process.env.META_AD_ACCOUNT_ID) &&
    Boolean(process.env.META_PAGE_ACCESS_TOKEN);

  if (!hasAdAccount) {
    return NextResponse.json({
      configured: false,
      message: 'Set META_AD_ACCOUNT_ID and META_PAGE_ACCESS_TOKEN (with ads_read scope)',
    });
  }

  const [spendResult, campaignsResult] = await Promise.allSettled([
    fetchAdSpend(),
    fetchCampaignBreakdown(),
  ]);

  return NextResponse.json({
    configured: true,
    spend: spendResult.status === 'fulfilled' ? spendResult.value : null,
    spend_error: spendResult.status === 'rejected' ? String(spendResult.reason) : null,
    campaigns: campaignsResult.status === 'fulfilled' ? campaignsResult.value : [],
    campaigns_error:
      campaignsResult.status === 'rejected' ? String(campaignsResult.reason) : null,
  });
}
