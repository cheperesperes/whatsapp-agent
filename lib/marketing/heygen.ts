const HEYGEN_BASE = 'https://api.heygen.com';

export interface HeyGenVideoJob {
  video_id: string;
}

export interface HeyGenVideoStatus {
  video_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  video_url?: string;
  thumbnail_url?: string;
  error?: string;
}

export async function createProductReviewVideo(
  script: string,
  campaignId: string
): Promise<HeyGenVideoJob> {
  const apiKey = process.env.HEYGEN_API_KEY;
  const avatarId = process.env.HEYGEN_AVATAR_ID;
  const voiceId = process.env.HEYGEN_VOICE_ID;

  if (!apiKey) throw new Error('HEYGEN_API_KEY not set');
  if (!avatarId) throw new Error('HEYGEN_AVATAR_ID not set');
  if (!voiceId) throw new Error('HEYGEN_VOICE_ID not set');

  const callbackUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/marketing/heygen-webhook`
    : process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/marketing/heygen-webhook`
    : null;

  const payload: Record<string, unknown> = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: voiceId,
          speed: 0.95,
        },
        background: {
          type: 'color',
          value: '#0f172a',
        },
      },
    ],
    dimension: { width: 1280, height: 720 },
    // callback_id is returned as-is in the webhook payload so we can correlate
    callback_id: campaignId,
  };

  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  const res = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HeyGen create video failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { data: { video_id: string } };
  return { video_id: data.data.video_id };
}

export async function getVideoStatus(videoId: string): Promise<HeyGenVideoStatus> {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error('HEYGEN_API_KEY not set');

  const res = await fetch(`${HEYGEN_BASE}/v1/video_status.get?video_id=${videoId}`, {
    headers: { 'X-Api-Key': apiKey },
  });

  if (!res.ok) {
    throw new Error(`HeyGen status check failed (${res.status})`);
  }

  const data = (await res.json()) as {
    data: {
      video_id: string;
      status: string;
      video_url?: string;
      thumbnail_url?: string;
      error?: string;
    };
  };

  return {
    video_id: data.data.video_id,
    status: data.data.status as HeyGenVideoStatus['status'],
    video_url: data.data.video_url,
    thumbnail_url: data.data.thumbnail_url,
    error: data.data.error,
  };
}
