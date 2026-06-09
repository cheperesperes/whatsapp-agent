import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { updateCampaign, updateContent } from '@/lib/marketing/db';
import { sendMarketingPreview } from '@/lib/marketing/notify';
import { resolvePendingImages } from '@/lib/marketing/image-finalize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Self-healing video finalizer. The marketing-daily cron leaves a campaign in
// `creating_video` after submitting the render job and relies on the provider's
// completion webhook to flip it to `pending_approval`. In prod that webhook is
// unreliable (Higgsfield never called it; campaigns sat stuck for hours). This
// cron polls the provider's status API directly and finalizes every stuck
// campaign — completes it when the video is ready, or times it out to a
// text-only `pending_approval` so nothing ever hangs forever.

const PROVIDER = (process.env.VIDEO_PROVIDER ?? 'heygen').toLowerCase();
const TIMEOUT_MIN = Number(process.env.VIDEO_FINALIZE_TIMEOUT_MIN ?? 15);

async function getStatus(jobId: string) {
  if (PROVIDER === 'higgsfield') {
    const { getVideoStatus } = await import('@/lib/marketing/higgsfield');
    return getVideoStatus(jobId);
  }
  const { getVideoStatus } = await import('@/lib/marketing/heygen');
  return getVideoStatus(jobId);
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return true;
  // Local/dev without a secret.
  if (!secret && process.env.VERCEL_ENV !== 'production') return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const { data: rows, error } = await sb
    .from('marketing_campaigns')
    .select('id, updated_at, product_sku, marketing_content(heygen_video_id, video_status, youtube_title)')
    .eq('status', 'creating_video');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const c of rows ?? []) {
    const content = Array.isArray((c as any).marketing_content)
      ? (c as any).marketing_content[0]
      : (c as any).marketing_content;
    const jobId: string | null = content?.heygen_video_id ?? null;
    const ageMin = (Date.now() - new Date((c as any).updated_at).getTime()) / 60000;

    const timeOut = async (reason: string) => {
      await Promise.all([
        updateContent((c as any).id, { video_status: 'failed' }),
        updateCampaign((c as any).id, { status: 'pending_approval', error_message: reason }),
      ]);
      await sendMarketingPreview((c as any).id, null);
    };

    if (!jobId) {
      if (ageMin > TIMEOUT_MIN) {
        await timeOut('No video job id — finalized as text-only.');
        results.push({ id: (c as any).id, action: 'failed_no_job' });
      } else {
        results.push({ id: (c as any).id, action: 'no_job_waiting' });
      }
      continue;
    }

    let st;
    try {
      st = await getStatus(jobId);
    } catch (e: any) {
      // Status API erroring/hanging. Keep retrying until the timeout window,
      // then finalize text-only so the campaign isn't stuck forever.
      if (ageMin > TIMEOUT_MIN) {
        await timeOut(`Video status check failing (${e?.message ?? e}) — finalized text-only.`);
        results.push({ id: (c as any).id, action: 'failed_status_error' });
      } else {
        results.push({ id: (c as any).id, action: 'status_error_retry', err: String(e?.message ?? e) });
      }
      continue;
    }

    if (st.status === 'completed') {
      // Product-integrity gate (rulebook §1): vision-check mid-video frames vs
      // the approved product photo before it can be approved/published. Graceful
      // — never blocks finalization; a detected morph just flags for the human.
      let verifyNote: string | null = null;
      let verdictOk = true; // default true → finishing proceeds unless a HARD integrity fail
      try {
        const sku = (c as any).product_sku as string | null;
        if (sku && st.video_url) {
          const { data: prod } = await sb
            .from('products')
            .select('primary_image_url, name')
            .ilike('sku', sku)
            .limit(1)
            .maybeSingle();
          const ref = (prod as any)?.primary_image_url as string | undefined;
          if (ref) {
            const { verifyVideoAccuracy } = await import('@/lib/marketing/video-verify');
            const v = await verifyVideoAccuracy(st.video_url, ref, (prod as any)?.name ?? sku);
            verdictOk = v.ok;
            verifyNote = v.skipped
              ? `⚠️ Verificación de video omitida (${v.note}) — revisar manualmente antes de publicar.`
              : v.passed
                ? `✅ Video verificado: producto íntegro (conf ${v.minConfidence}, ${v.framesChecked} frames).`
                : `🚨 VERIFICACIÓN FALLÓ — posible producto distorsionado: ${v.issues.join('; ')}. REVISAR/RECHAZAR.`;
          }
        }
      } catch (e: any) {
        verifyNote = `⚠️ Verificación de video con error (${e?.message ?? e}) — revisar manualmente.`;
      }

      // Finish the clip: burn brand captions + a music bed, then store it.
      // Skipped when integrity hard-failed (don't polish a clip the human will
      // reject) — graceful, so a finish failure just keeps the raw render URL.
      let finalUrl: string | undefined = st.video_url ?? undefined;
      let finishNote: string | null = null;
      if (verdictOk && st.video_url) {
        try {
          const { finishVideo } = await import('@/lib/marketing/video-post');
          const fin = await finishVideo(st.video_url, {
            campaignId: (c as any).id,
            headline: content?.youtube_title ?? null,
            cta: 'oiikon.com',
          });
          if (fin.ok && fin.url) {
            finalUrl = fin.url;
            finishNote = `🎬 Video finalizado (${fin.note}).`;
          } else {
            finishNote = `🎬 Captions/música omitidas (${fin.note}).`;
          }
        } catch (e: any) {
          finishNote = `🎬 Finalización de video con error (${e?.message ?? e}).`;
        }
      }

      const note = [verifyNote, finishNote].filter(Boolean).join(' ') || null;
      await Promise.all([
        updateContent((c as any).id, { video_status: 'ready', video_url: finalUrl }),
        updateCampaign((c as any).id, { status: 'pending_approval', error_message: note }),
      ]);
      await sendMarketingPreview((c as any).id, finalUrl ?? null);
      results.push({ id: (c as any).id, action: 'finalized_ready', has_url: !!finalUrl, verify: verifyNote, finish: finishNote });
    } else if (st.status === 'failed') {
      await timeOut(st.error ?? 'Video generation failed.');
      results.push({ id: (c as any).id, action: 'finalized_failed' });
    } else if (ageMin > TIMEOUT_MIN) {
      await timeOut(`Video timed out after ~${Math.round(ageMin)} min — finalized text-only.`);
      results.push({ id: (c as any).id, action: 'timed_out' });
    } else {
      results.push({ id: (c as any).id, action: 'still_processing', age_min: Math.round(ageMin) });
    }
  }

  // Self-heal pending AI scene images too (orthogonal to the video lifecycle).
  const imageResults = await resolvePendingImages(sb);

  return NextResponse.json({
    ok: true,
    provider: PROVIDER,
    checked: rows?.length ?? 0,
    results,
    images: imageResults,
  });
}
