/**
 * Higgsfield Cloud API video provider — drop-in alternative to heygen.ts.
 *
 * HeyGen makes a talking-AVATAR video reading a script; Higgsfield makes a
 * cinematic PRODUCT-MOTION clip from a still image (image-to-video). For
 * PECRON product ads that's the better format.
 *
 * Wired into the marketing-daily cron behind the VIDEO_PROVIDER env flag
 * (default 'heygen' → nothing changes). To switch, set:
 *   VIDEO_PROVIDER=higgsfield
 *   HIGGSFIELD_API_KEY=...        (from cloud.higgsfield.ai → API Keys)
 *   HIGGSFIELD_API_SECRET=...     (the key's secret — auth is "Key key:secret")
 *   HIGGSFIELD_VIDEO_MODEL=...    (optional, default higgsfield-ai/dop/standard)
 * The Cloud account also needs CREDITS (billed separately from the MCP).
 *
 * Spec (verified against docs.higgsfield.ai 2026-05-29):
 *   Base: https://platform.higgsfield.ai
 *   Submit:  POST /{model_id}                       Authorization: Key KEY:SECRET
 *            body { image_url, prompt, duration }    → { status:"queued", request_id, ... }
 *   Status:  GET  /requests/{request_id}/status      → { status, video:{url}, images:[{url}] }
 *   Statuses: queued | in_progress | nsfw | failed | completed  (nsfw/failed refund credits)
 *
 * NOTE: use a DoP model — Seedance over-flags clean product renders as NSFW.
 */
const HIGGSFIELD_BASE = process.env.HIGGSFIELD_BASE_URL ?? 'https://platform.higgsfield.ai';
const HIGGSFIELD_MODEL = process.env.HIGGSFIELD_VIDEO_MODEL ?? 'higgsfield-ai/dop/standard';

export interface HiggsfieldVideoJob {
  video_id: string; // the Higgsfield request_id
}

export interface HiggsfieldVideoStatus {
  video_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  video_url?: string;
  error?: string;
}

function authHeader(): string {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) throw new Error('HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET not set');
  return `Key ${key}:${secret}`;
}

/** Supabase product images are .webp; proxy to JPEG (Higgsfield wants PNG/JPEG). */
function toJpeg(url: string): string {
  if (!/\.webp(\?|$)/i.test(url)) return url;
  const stripped = url.replace(/^https?:\/\//, '');
  return `https://wsrv.nl/?url=${encodeURIComponent(stripped)}&output=jpg`;
}

/** Map Higgsfield's queue statuses onto our provider-agnostic enum. */
function mapStatus(raw: string): HiggsfieldVideoStatus['status'] {
  const s = raw.toLowerCase();
  if (s === 'completed') return 'completed';
  if (s === 'nsfw' || s === 'failed') return 'failed';
  if (s === 'in_progress') return 'processing';
  return 'pending'; // queued / unknown
}

/**
 * Submit an image-to-video job: animate the first product image with a short
 * motion prompt. campaignId is round-tripped via the webhook URL query string
 * so the webhook can correlate the result back to the campaign.
 */
export async function createProductVideo(
  motionPrompt: string,
  campaignId: string,
  productImages: string[] = [],
): Promise<HiggsfieldVideoJob> {
  const inputImage = productImages.find((u) => typeof u === 'string' && u.startsWith('https://'));
  if (!inputImage) throw new Error('Higgsfield image-to-video needs a product image');

  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL ?? '';
  const webhookUrl = appUrl
    ? `${appUrl}/api/marketing/higgsfield-webhook?campaign=${encodeURIComponent(campaignId)}`
    : undefined;

  const body: Record<string, unknown> = {
    image_url: toJpeg(inputImage),
    prompt: motionPrompt,
    duration: Number(process.env.HIGGSFIELD_VIDEO_DURATION ?? 5),
  };
  if (webhookUrl) body.webhook_url = webhookUrl;

  const res = await fetch(`${HIGGSFIELD_BASE}/${HIGGSFIELD_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Higgsfield create video failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) {
    throw new Error(`Higgsfield response missing request_id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { video_id: data.request_id };
}

export async function getVideoStatus(requestId: string): Promise<HiggsfieldVideoStatus> {
  const res = await fetch(`${HIGGSFIELD_BASE}/requests/${encodeURIComponent(requestId)}/status`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    // Hard timeout — the status endpoint has hung indefinitely in prod, which
    // left campaigns stuck in "creating_video" forever. Fail fast instead.
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Higgsfield status check failed (${res.status})`);

  const data = (await res.json()) as {
    status?: string;
    video?: { url?: string };
    images?: Array<{ url?: string }>;
    error?: string;
    message?: string;
  };

  return {
    video_id: requestId,
    status: mapStatus(String(data.status ?? '')),
    video_url: data.video?.url ?? data.images?.[0]?.url ?? undefined,
    error: data.error ?? data.message,
  };
}
