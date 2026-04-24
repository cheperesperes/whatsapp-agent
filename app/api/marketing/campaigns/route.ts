import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';

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
  const sb = createServiceClient();

  // Load campaigns, content, and performance separately. Embedded selects were
  // dropping today's row intermittently — suspected PostgREST quirk — and were
  // returning 1:1 relations as objects (breaking UI code that expected arrays).
  const [
    { data: campaigns, error },
    { data: contentRows },
    { data: perfRows },
    { data: groups },
    { data: memory },
  ] = await Promise.all([
    sb
      .from('marketing_campaigns')
      .select('id, date, status, daily_theme, product_sku, error_message, created_at')
      .order('date', { ascending: false })
      .limit(30),
    sb
      .from('marketing_content')
      .select('campaign_id, facebook_post_id, instagram_post_id, youtube_video_id, video_url, video_status, facebook_post, instagram_caption, youtube_title, youtube_description, youtube_script, youtube_tags, google_ad_headlines, google_ad_descriptions, published_at'),
    sb
      .from('marketing_performance')
      .select('campaign_id, facebook_likes, facebook_comments, facebook_shares, facebook_reach, instagram_likes, instagram_comments, youtube_views, youtube_likes'),
    sb
      .from('marketing_facebook_groups')
      .select('id, name, url, last_posted_at, active')
      .order('discovered_at', { ascending: false })
      .limit(50),
    sb.from('marketing_agent_memory').select('*').eq('id', 1).maybeSingle(),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const contentByCampaign = new Map<string, unknown>();
  for (const c of contentRows ?? []) {
    contentByCampaign.set((c as { campaign_id: string }).campaign_id, c);
  }
  const perfByCampaign = new Map<string, unknown>();
  for (const p of perfRows ?? []) {
    perfByCampaign.set((p as { campaign_id: string }).campaign_id, p);
  }

  const enriched = (campaigns ?? []).map((c) => ({
    ...c,
    marketing_content: contentByCampaign.has(c.id) ? [contentByCampaign.get(c.id)] : [],
    marketing_performance: perfByCampaign.has(c.id) ? [perfByCampaign.get(c.id)] : [],
  }));

  return NextResponse.json({ campaigns: enriched, groups: groups ?? [], memory });
}
