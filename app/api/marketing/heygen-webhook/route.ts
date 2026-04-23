import { NextRequest, NextResponse } from 'next/server';
import { updateCampaign, updateContent } from '@/lib/marketing/db';
import { sendMarketingPreview } from '@/lib/marketing/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HeyGenWebhookPayload {
  event_type: string;
  event_data: {
    video_id: string;
    video_url?: string;
    thumbnail_url?: string;
    callback_id?: string; // our campaign_id
    error?: string;
  };
}

export async function POST(req: NextRequest) {
  let payload: HeyGenWebhookPayload;

  try {
    payload = (await req.json()) as HeyGenWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { event_type, event_data } = payload;
  const campaignId = event_data?.callback_id;
  const videoId = event_data?.video_id;

  console.log(`[heygen-webhook] event=${event_type} video_id=${videoId} campaign_id=${campaignId}`);

  if (!campaignId || !videoId) {
    return NextResponse.json({ ok: true, note: 'no callback_id — ignoring' });
  }

  if (event_type === 'avatar_video.success' || event_type === 'video.completed') {
    const videoUrl = event_data.video_url ?? null;

    await Promise.all([
      updateContent(campaignId, {
        heygen_video_id: videoId,
        video_url: videoUrl ?? undefined,
        video_status: 'ready',
      }),
      updateCampaign(campaignId, { status: 'pending_approval' }),
    ]);

    // Notify Eduardo with preview
    await sendMarketingPreview(campaignId, videoUrl);

    console.log(`[heygen-webhook] campaign ${campaignId} ready for approval — operator notified`);
    return NextResponse.json({ ok: true, status: 'pending_approval' });
  }

  if (event_type === 'avatar_video.fail' || event_type === 'video.failed') {
    const errMsg = event_data.error ?? 'HeyGen video generation failed';

    await Promise.all([
      updateContent(campaignId, { video_status: 'failed' }),
      updateCampaign(campaignId, {
        status: 'pending_approval', // still usable as text-only campaign
        error_message: errMsg,
      }),
    ]);

    // Notify Eduardo — can still approve text-only
    await sendMarketingPreview(campaignId, null);

    console.warn(`[heygen-webhook] campaign ${campaignId} video failed: ${errMsg}`);
    return NextResponse.json({ ok: true, status: 'pending_approval_no_video' });
  }

  // Unknown event type — just ack
  return NextResponse.json({ ok: true });
}
