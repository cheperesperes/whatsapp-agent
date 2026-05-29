import { NextRequest, NextResponse } from 'next/server';
import { updateCampaign, updateContent } from '@/lib/marketing/db';
import { sendMarketingPreview } from '@/lib/marketing/notify';
import { getVideoStatus } from '@/lib/marketing/higgsfield';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Higgsfield video-completion webhook. campaignId arrives as `?campaign=` (the
 * Cloud API has no callback field, so the cron embeds it in the webhook URL).
 * The webhook body shape isn't guaranteed, so we extract the job id and re-fetch
 * authoritative status/url via getVideoStatus rather than trusting the payload.
 */
export async function POST(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get('campaign');

  let body: Record<string, any> = {};
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    /* some webhooks send empty/non-JSON bodies — tolerate it */
  }

  const videoId =
    body.request_id ?? body.id ?? body.data?.request_id ?? body.video_id ?? null;

  console.log(`[higgsfield-webhook] campaign=${campaignId} video_id=${videoId}`);

  if (!campaignId || !videoId) {
    return NextResponse.json({ ok: true, note: 'missing campaign or id — ignoring' });
  }

  let status: Awaited<ReturnType<typeof getVideoStatus>>;
  try {
    status = await getVideoStatus(String(videoId));
  } catch (err) {
    console.warn(`[higgsfield-webhook] status fetch failed for ${videoId}:`, err);
    return NextResponse.json({ ok: true, note: 'status fetch failed — will rely on retry' });
  }

  if (status.status === 'completed') {
    await Promise.all([
      updateContent(campaignId, {
        heygen_video_id: String(videoId), // reuse existing column for the video job id
        video_url: status.video_url ?? undefined,
        video_status: 'ready',
      }),
      updateCampaign(campaignId, { status: 'pending_approval' }),
    ]);
    await sendMarketingPreview(campaignId, status.video_url ?? null);
    console.log(`[higgsfield-webhook] campaign ${campaignId} ready — operator notified`);
    return NextResponse.json({ ok: true, status: 'pending_approval' });
  }

  if (status.status === 'failed') {
    const errMsg = status.error ?? 'Higgsfield video generation failed';
    await Promise.all([
      updateContent(campaignId, { video_status: 'failed' }),
      updateCampaign(campaignId, { status: 'pending_approval', error_message: errMsg }),
    ]);
    await sendMarketingPreview(campaignId, null);
    console.warn(`[higgsfield-webhook] campaign ${campaignId} video failed: ${errMsg}`);
    return NextResponse.json({ ok: true, status: 'pending_approval_no_video' });
  }

  // Still processing — ack; a later webhook or the next poll will finalize.
  return NextResponse.json({ ok: true, status: status.status });
}
