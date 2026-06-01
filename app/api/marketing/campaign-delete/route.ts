import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { deleteFacebookPost, deleteInstagramPost } from '@/lib/marketing/publisher';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Permanently delete a marketing campaign (and its content/performance rows).
// If it was already published, best-effort delete the live FB/IG posts first so
// we don't orphan them. Session-authed like the other dashboard routes.

async function requireAuth(req: NextRequest): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }
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
    /* ignore */
  }
  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const sb = createServiceClient();
  const id = body.campaign_id;

  // Best-effort: if this campaign was published, take the live posts down first.
  const { data: content } = await sb
    .from('marketing_content')
    .select('facebook_post_id, instagram_post_id')
    .eq('campaign_id', id)
    .maybeSingle();

  const social: Record<string, 'deleted' | 'skipped' | 'failed'> = { facebook: 'skipped', instagram: 'skipped' };
  if (content?.facebook_post_id) {
    social.facebook = (await deleteFacebookPost(content.facebook_post_id).catch(() => false)) ? 'deleted' : 'failed';
  }
  if (content?.instagram_post_id) {
    social.instagram = (await deleteInstagramPost(content.instagram_post_id).catch(() => false)) ? 'deleted' : 'failed';
  }

  // Remove child rows first (no ON DELETE CASCADE assumed), then the campaign.
  await sb.from('marketing_performance').delete().eq('campaign_id', id);
  await sb.from('marketing_content').delete().eq('campaign_id', id);
  const { error } = await sb.from('marketing_campaigns').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: id, social });
}
