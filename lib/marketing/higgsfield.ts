/**
 * Higgsfield Cloud API video provider — drop-in alternative to heygen.ts.
 *
 * HeyGen makes a talking-AVATAR video reading a script; Higgsfield makes a
 * cinematic PRODUCT-MOTION clip from a still image (image-to-video). For
 * PECRON product ads that's the better format.
 *
 * Wired into the marketing-daily cron behind the VIDEO_PROVIDER env flag
 * (default 'heygen' → nothing changes). Set VIDEO_PROVIDER=higgsfield AND
 * HIGGSFIELD_API_KEY to switch.
 *
 * API (https://api.higgsfield.ai, Bearer auth):
 *   POST /v1/generations            → { id, status }
 *   GET  /v1/generations/{id}        → { status, ...output url }
 * Response field names are parsed defensively — VERIFY exact schema against
 * cloud.higgsfield.ai with a live key before flipping the flag in prod.
 *
 * IMPORTANT (learned 2026-05-28): the Seedance model false-flags clean product
 * renders as NSFW. Use a Kling-class model — set HIGGSFIELD_VIDEO_MODEL.
 */
const HIGGSFIELD_BASE = process.env.HIGGSFIELD_BASE_URL ?? 'https://api.higgsfield.ai';

export interface HiggsfieldVideoJob {
  video_id: string;
}

export interface HiggsfieldVideoStatus {
  video_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  video_url?: string;
  error?: string;
}

/** Supabase product images are .webp; proxy to JPEG (Higgsfield rejects webp). */
function toJpeg(url: string): string {
  if (!/\.webp(\?|$)/i.test(url)) return url;
  const stripped = url.replace(/^https?:\/\//, '');
  return `https://wsrv.nl/?url=${encodeURIComponent(stripped)}&output=jpg`;
}

/**
 * Submit an image-to-video job. Animates the first product image with a short
 * motion prompt. campaignId is round-tripped via the webhook URL query string
 * (the API has no callback field), so the webhook can correlate the result.
 */
export async function createProductVideo(
  motionPrompt: string,
  campaignId: string,
  productImages: string[] = [],
): Promise<HiggsfieldVideoJob> {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  if (!apiKey) throw new Error('HIGGSFIELD_API_KEY not set');

  const inputImage = productImages.find((u) => typeof u === 'string' && u.startsWith('https://'));
  if (!inputImage) throw new Error('Higgsfield image-to-video needs a product image');

  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL ?? '';
  const webhookUrl = appUrl
    ? `${appUrl}/api/marketing/higgsfield-webhook?campaign=${encodeURIComponent(campaignId)}`
    : undefined;

  const payload: Record<string, unknown> = {
    task: 'image-to-video',
    model: process.env.HIGGSFIELD_VIDEO_MODEL ?? 'kling-v2',
    input_image: toJpeg(inputImage),
    duration: Number(process.env.HIGGSFIELD_VIDEO_DURATION ?? 5),
    motion_intensity: 'low',
    prompt: motionPrompt,
  };
  if (webhookUrl) payload.webhook_url = webhookUrl;

  const res = await fetch(`${HIGGSFIELD_BASE}/v1/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Higgsfield create video failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as Record<string, any>;
  const id = data.id ?? data.generation_id ?? data.data?.id;
  if (!id) throw new Error(`Higgsfield response missing job id: ${JSON.stringify(data).slice(0, 200)}`);
  return { video_id: String(id) };
}

export async function getVideoStatus(videoId: string): Promise<HiggsfieldVideoStatus> {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  if (!apiKey) throw new Error('HIGGSFIELD_API_KEY not set');

  const res = await fetch(`${HIGGSFIELD_BASE}/v1/generations/${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Higgsfield status check failed (${res.status})`);

  const data = (await res.json()) as Record<string, any>;
  const rawStatus = String(data.status ?? data.state ?? '').toLowerCase();
  const status: HiggsfieldVideoStatus['status'] =
    rawStatus.includes('complet') || rawStatus.includes('succe') || rawStatus === 'done'
      ? 'completed'
      : rawStatus.includes('fail') || rawStatus.includes('error') || rawStatus === 'nsfw'
        ? 'failed'
        : rawStatus.includes('process') || rawStatus.includes('progress') || rawStatus.includes('run')
          ? 'processing'
          : 'pending';

  // Output URL lives under different keys depending on API version — probe all.
  const video_url: string | undefined =
    data.output_url ??
    data.video_url ??
    data.url ??
    data.output?.url ??
    data.output?.video_url ??
    data.result?.url ??
    data.results?.[0]?.url ??
    undefined;

  return { video_id: videoId, status, video_url, error: data.error ?? data.message };
}
