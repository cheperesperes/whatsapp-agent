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

  const { data: campaigns, error } = await sb
    .from('marketing_campaigns')
    .select(`
      id, date, status, daily_theme, product_sku, error_message, created_at,
      marketing_content (
        facebook_post_id, instagram_post_id, youtube_video_id,
        video_url, video_status,
        facebook_post, instagram_caption,
        youtube_title, youtube_description, youtube_script, youtube_tags,
        google_ad_headlines, google_ad_descriptions,
        published_at
      ),
      marketing_performance (
        facebook_likes, facebook_comments, facebook_shares, facebook_reach,
        instagram_likes, instagram_comments, youtube_views, youtube_likes
      )
    `)
    .order('date', { ascending: false })
    .limit(30);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: groups } = await sb
    .from('marketing_facebook_groups')
    .select('id, name, url, last_posted_at, active')
    .order('discovered_at', { ascending: false })
    .limit(50);

  const { data: memory } = await sb
    .from('marketing_agent_memory')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  return NextResponse.json({ campaigns: campaigns ?? [], groups: groups ?? [], memory });
}
