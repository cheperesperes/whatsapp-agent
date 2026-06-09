import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateContent } from '@/lib/marketing/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Remove ONLY the generated/uploaded image OR video from a campaign, leaving the
// text (facebook_post, captions, etc.) untouched. Lets the operator drop the
// agent's media and publish text-only or upload their own. Session-authed.
async function isAuthenticated(req: NextRequest): Promise<boolean> {
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
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { campaign_id?: string; kind?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'expected JSON' }, { status: 400 });
  }
  const campaignId = String(body.campaign_id ?? '').trim();
  const kind = String(body.kind ?? '');
  if (!campaignId) return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  if (kind !== 'image' && kind !== 'video') {
    return NextResponse.json({ error: "kind must be 'image' or 'video'" }, { status: 400 });
  }

  if (kind === 'image') {
    await updateContent(campaignId, { image_url: null, image_status: 'skipped' });
  } else {
    await updateContent(campaignId, { video_url: null, video_status: 'skipped', heygen_video_id: null });
  }
  return NextResponse.json({ ok: true });
}
