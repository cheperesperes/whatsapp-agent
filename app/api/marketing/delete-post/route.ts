import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { deleteFacebookPost, deleteInstagramPost } from '@/lib/marketing/publisher';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireAuth(req: NextRequest): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return true; // dev with no env
  const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { campaign_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // ignore
  }

  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const sb = createServiceClient();

  const { data: content } = await sb
    .from('marketing_content')
    .select('facebook_post_id, instagram_post_id, youtube_video_id')
    .eq('campaign_id', body.campaign_id)
    .single();

  if (!content) {
    return NextResponse.json({ error: 'content not found' }, { status: 404 });
  }

  const results: Record<string, 'deleted' | 'skipped' | 'failed'> = {
    facebook: 'skipped',
    instagram: 'skipped',
    youtube: 'skipped',
  };

  if (content.facebook_post_id) {
    results.facebook = (await deleteFacebookPost(content.facebook_post_id)) ? 'deleted' : 'failed';
  }
  if (content.instagram_post_id) {
    results.instagram = (await deleteInstagramPost(content.instagram_post_id)) ? 'deleted' : 'failed';
  }
  // YouTube delete needs a separate OAuth token (different scope) — leave for now.
  if (content.youtube_video_id) {
    results.youtube = 'skipped';
  }

  // Clear the post IDs and revert the campaign to pending_approval so the
  // operator can re-publish (with or without video) or regenerate.
  await sb
    .from('marketing_content')
    .update({
      facebook_post_id: null,
      instagram_post_id: null,
      published_at: null,
    })
    .eq('campaign_id', body.campaign_id);

  await sb
    .from('marketing_campaigns')
    .update({ status: 'pending_approval', error_message: null })
    .eq('id', body.campaign_id);

  return NextResponse.json({ ok: true, results });
}
