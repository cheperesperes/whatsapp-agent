import { NextRequest, NextResponse } from 'next/server';
import { publishToFacebook, publishToInstagram } from '@/lib/marketing/publisher';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // IG image publish can take a few seconds

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/marketing/social-post
// Body: { imageUrl: string (https), caption?: string, platforms?: ('facebook'|'instagram')[] }
//
// One-off image + caption post to the Oiikon Facebook Page (and optionally
// Instagram), SERVER-SIDE via the Page token (publishToFacebook/publishToInstagram).
//
// Why: posting a photo through the Facebook web composer is unreliable (the
// renderer freezes, the file-upload flow breaks). This does it through the Graph
// API instead — no browser, no composer. Use for occasion posts (Father's Day,
// etc.) where the asset already lives at a public https URL (e.g. our CDN).
//
// Auth: behind the dashboard session (middleware gates /api/marketing/*), so it's
// admin-only. Defaults to facebook; pass platforms to include instagram.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    imageUrl?: string;
    caption?: string;
    platforms?: string[];
  };

  const imageUrl = (body.imageUrl ?? '').trim();
  const caption = (body.caption ?? '').trim();
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    return NextResponse.json({ error: 'imageUrl (https) is required' }, { status: 400 });
  }

  const platforms =
    Array.isArray(body.platforms) && body.platforms.length ? body.platforms : ['facebook'];

  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  if (platforms.includes('facebook')) {
    try {
      results.facebook = await publishToFacebook(caption, null, imageUrl);
    } catch (e) {
      errors.facebook = e instanceof Error ? e.message : String(e);
    }
  }

  if (platforms.includes('instagram')) {
    try {
      const ig = await publishToInstagram(caption, null, imageUrl);
      results.instagram = ig ?? { skipped: 'instagram not configured (META_IG_ACCOUNT_ID) or container failed' };
    } catch (e) {
      errors.instagram = e instanceof Error ? e.message : String(e);
    }
  }

  const ok = Object.keys(errors).length === 0;
  return NextResponse.json({ ok, posted: platforms, results, errors }, { status: ok ? 200 : 207 });
}
