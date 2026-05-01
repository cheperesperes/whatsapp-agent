import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  getPendingApprovalCampaign,
  updateCampaign,
  getContent,
  updateContent,
  getActiveGroups,
  markGroupPosted,
} from '@/lib/marketing/db';
import {
  publishToFacebook,
  publishToInstagram,
  publishToYouTube,
} from '@/lib/marketing/publisher';
import { getVideoStatus } from '@/lib/marketing/heygen';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import { getProductImages } from '@/lib/supabase';

async function sendWhatsAppSafe(to: string, msg: string): Promise<void> {
  try {
    await sendWhatsAppMessage(to, msg);
  } catch (err) {
    console.warn('[marketing/approve] WhatsApp send skipped:', err instanceof Error ? err.message : err);
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  // Allow internal calls from webhook (same server, no cookie)
  const internalSecret = process.env.CRON_SECRET;
  if (internalSecret && req.headers.get('x-internal-secret') === internalSecret) return true;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Fail CLOSED in production. Only fall through when explicitly running
  // outside production (local dev / preview without Supabase configured).
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: () => {},
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  return Boolean(user);
}

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { approved?: boolean; campaign_id?: string; text_only?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // ignore — manual trigger from dashboard sends empty body
  }

  // Find the campaign to approve/reject
  const campaign = body.campaign_id
    ? await (async () => {
        const { createServiceClient } = await import('@/lib/supabase');
        const { data } = await createServiceClient()
          .from('marketing_campaigns')
          .select('*')
          .eq('id', body.campaign_id)
          .single();
        return data;
      })()
    : await getPendingApprovalCampaign();

  if (!campaign) {
    return NextResponse.json({ ok: false, error: 'No pending campaign found' }, { status: 404 });
  }

  const approved = body.approved !== false; // default true

  if (!approved) {
    await updateCampaign(campaign.id, { status: 'rejected' });
    await sendWhatsAppSafe(
      OPERATOR_PHONE,
      `❌ Campaña del ${campaign.date} cancelada. La próxima campaña se generará mañana a las 7am.`
    );
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  // Approve → publish
  await updateCampaign(campaign.id, { status: 'publishing' });

  const content = await getContent(campaign.id);
  if (!content) {
    await updateCampaign(campaign.id, { status: 'failed', error_message: 'content row missing' });
    return NextResponse.json({ ok: false, error: 'content not found' }, { status: 500 });
  }

  const textOnly = body.text_only === true;

  // HeyGen webhook payloads sometimes arrive without the video_url even when
  // the render succeeded. If we have the heygen_video_id, resolve the URL
  // from the status API right before publishing so IG/YT don't get skipped.
  // Skip this entirely when the operator chose "text only" — they already
  // decided they don't want the video.
  if (!textOnly && !content.video_url && content.heygen_video_id) {
    try {
      const status = await getVideoStatus(content.heygen_video_id);
      if (status.video_url) {
        content.video_url = status.video_url;
        await updateContent(campaign.id, { video_url: status.video_url, video_status: 'ready' });
      }
    } catch (err) {
      console.warn('[marketing/approve] HeyGen status resolve failed:', err instanceof Error ? err.message : err);
    }
  }

  // Effective video URL — null in text-only mode so FB posts as text and IG
  // falls back to the image-only path.
  const publishVideoUrl = textOnly ? null : (content.video_url ?? null);

  // For IG image-only fallback (text-only mode), pull the product photo so
  // we have something to attach — IG can't accept a caption without media.
  let igFallbackImage: string | null = null;
  if (textOnly && campaign.product_sku) {
    const imgs = await getProductImages(campaign.product_sku, 1);
    igFallbackImage = imgs[0] ?? null;
  }

  const results: Record<string, string | null> = {
    facebook: null,
    instagram: null,
    youtube: null,
  };
  const errors: string[] = [];

  // ── Facebook ───────────────────────────────────────────────────────────────
  try {
    const fb = await publishToFacebook(content.facebook_post ?? '', publishVideoUrl);
    results.facebook = fb.post_id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Facebook: ${msg}`);
    console.error('[marketing/approve] Facebook publish error:', msg);
  }

  // ── Instagram ─────────────────────────────────────────────────────────────
  try {
    const ig = await publishToInstagram(content.instagram_caption ?? '', publishVideoUrl, igFallbackImage);
    results.instagram = ig?.post_id ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Instagram: ${msg}`);
    console.error('[marketing/approve] Instagram publish error:', msg);
  }

  // ── YouTube ────────────────────────────────────────────────────────────────
  // Skip YouTube in text-only mode — uploading text-only to YouTube is not a
  // thing.
  if (!textOnly && content.video_url && content.youtube_title) {
    try {
      const yt = await publishToYouTube(
        content.video_url,
        content.youtube_title,
        content.youtube_description ?? '',
        content.youtube_tags ?? []
      );
      results.youtube = yt?.video_id ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`YouTube: ${msg}`);
      console.error('[marketing/approve] YouTube publish error:', msg);
    }
  }

  // ── Save publish results ───────────────────────────────────────────────────
  // `published_at` is set ONLY when at least one platform succeeded —
  // previously it was stamped unconditionally, which made the dashboard
  // show silent failures as successful publishes (today's 2026-05-01 run
  // was the canonical example: every platform errored but status='published'
  // and published_at was set, so nobody noticed for hours).
  const anyPlatformSucceeded =
    Boolean(results.facebook) ||
    Boolean(results.instagram) ||
    Boolean(results.youtube);

  const contentPatch: Parameters<typeof updateContent>[1] = {
    facebook_post_id: results.facebook ?? undefined,
    instagram_post_id: results.instagram ?? undefined,
    youtube_video_id: results.youtube ?? undefined,
  };
  if (anyPlatformSucceeded) {
    contentPatch.published_at = new Date().toISOString();
  }
  await updateContent(campaign.id, contentPatch);

  // Mark top groups as posted (so rotation works next time) — only when
  // at least one platform actually published. Otherwise we'd advance the
  // rotation cursor on a no-op run and skip those groups next time too.
  if (anyPlatformSucceeded) {
    const groups = await getActiveGroups();
    await Promise.all(groups.slice(0, 5).map((g) => markGroupPosted(g.id)));
  }

  // Status now reflects the truth. Three buckets:
  //   • all platforms published cleanly → 'published'
  //   • at least one published, others errored → 'partial'
  //   • zero platforms published → 'failed'
  // The error_message column captures every non-empty error string so the
  // dashboard can surface it without requiring a Vercel log dive.
  let finalStatus: 'published' | 'partial' | 'failed';
  if (errors.length === 0) finalStatus = 'published';
  else if (anyPlatformSucceeded) finalStatus = 'partial';
  else finalStatus = 'failed';

  await updateCampaign(campaign.id, {
    status: finalStatus,
    error_message: errors.length > 0 ? errors.join(' | ').slice(0, 2000) : null,
  });

  // Confirm to Eduardo via WhatsApp. The header now reflects outcome —
  // 'publicada' for full success, 'parcial' when some platforms succeeded,
  // 'falló' when nothing went out.
  const successLines = [
    results.facebook && `✅ Facebook: publicado`,
    results.instagram && `✅ Instagram: publicado`,
    results.youtube && `✅ YouTube: publicado`,
    errors.length > 0 && `⚠️ Errores: ${errors.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const headerEmoji =
    finalStatus === 'published' ? '🚀'
    : finalStatus === 'partial' ? '⚠️'
    : '❌';
  const headerLabel =
    finalStatus === 'published' ? 'publicada'
    : finalStatus === 'partial' ? 'publicada parcialmente'
    : 'falló al publicar';

  await sendWhatsAppSafe(
    OPERATOR_PHONE,
    `${headerEmoji} *Campaña ${campaign.date} ${headerLabel}*\n\n${successLines}\n\nTema: _${campaign.daily_theme}_`
  );

  return NextResponse.json({
    ok: anyPlatformSucceeded,
    campaign_id: campaign.id,
    status: finalStatus,
    published: results,
    errors: errors.length > 0 ? errors : undefined,
  }, { status: anyPlatformSucceeded ? 200 : 502 });
}
