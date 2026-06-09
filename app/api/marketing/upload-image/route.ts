import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import sharp from 'sharp';
import { updateContent } from '@/lib/marketing/db';
import { uploadMarketingImage } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Operator image upload — attach your OWN image to a campaign (e.g. a polished
// Nano Banana / Flow render), overriding the auto-composite. Sets
// marketing_content.image_url so the preview + publish use it immediately.
// Session-authed (dashboard cookie).
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  const campaignId = String(form.get('campaign_id') ?? '').trim();
  const file = form.get('file');
  if (!campaignId) return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'file must be an image' }, { status: 400 });
  }
  if (file.size > 12 * 1024 * 1024) {
    return NextResponse.json({ error: 'image too large (max 12MB)' }, { status: 400 });
  }

  try {
    const raw = Buffer.from(await file.arrayBuffer());
    // Normalize: respect EXIF orientation, cap dimensions, re-encode as JPEG.
    const jpg = await sharp(raw)
      .rotate()
      .resize({ width: 1600, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const url = await uploadMarketingImage(`${campaignId}-up-${Date.now()}.jpg`, jpg);
    if (!url) return NextResponse.json({ error: 'storage upload failed' }, { status: 502 });
    await updateContent(campaignId, { image_url: url, image_status: 'ready' });
    return NextResponse.json({ ok: true, image_url: url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[marketing/upload-image]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
