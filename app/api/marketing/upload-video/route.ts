import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { updateContent } from '@/lib/marketing/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Operator VIDEO upload — attach your own video to a campaign, overriding the
// generated one. Videos are too big to proxy through a serverless function
// (request-body limit), so this issues a SIGNED Supabase Storage upload URL the
// browser PUTs the file to directly, then a 'confirm' sets content.video_url.
// Session-authed (dashboard cookie).
const BUCKET = process.env.MARKETING_IMAGE_BUCKET || 'media-content';

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

  let body: { campaign_id?: string; filename?: string; confirm_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'expected JSON' }, { status: 400 });
  }
  const campaignId = String(body.campaign_id ?? '').trim();
  if (!campaignId) return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });

  const sb = createServiceClient();

  // Step 2 — confirm: the browser finished uploading; point the campaign at it.
  if (body.confirm_url) {
    await updateContent(campaignId, {
      video_url: String(body.confirm_url),
      video_status: 'ready',
      heygen_video_id: null, // uploaded video, not a provider job
    });
    return NextResponse.json({ ok: true });
  }

  // Step 1 — sign: hand back a signed upload URL the browser PUTs the file to.
  const ext = (String(body.filename ?? 'video.mp4').split('.').pop() ?? 'mp4')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'mp4';
  const path = `marketing-videos/${campaignId}-${Date.now()}.${ext}`;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'could not create upload URL' }, { status: 500 });
  }
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  return NextResponse.json({ ok: true, signedUrl: data.signedUrl, publicUrl: pub?.publicUrl ?? null });
}
