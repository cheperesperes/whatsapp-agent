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

interface AvatarPair {
  look_id: string;
  voice_id: string;
  name?: string;
}

// HEYGEN_AVATARS is a JSON array of {look_id, voice_id, name?} that the
// pipeline rotates through (one per day). When empty/missing, falls back
// to the single HEYGEN_AVATAR_ID / HEYGEN_VOICE_ID pair so older deploys
// keep working.
function pickAvatar(): AvatarPair {
  const raw = process.env.HEYGEN_AVATARS;
  if (raw) {
    try {
      const list = JSON.parse(raw) as AvatarPair[];
      if (Array.isArray(list) && list.length > 0) {
        const dayOfYear = Math.floor(Date.now() / 86400000);
        return list[dayOfYear % list.length];
      }
    } catch {
      // fall through to legacy single-avatar env vars
    }
  }
  const lookId = process.env.HEYGEN_AVATAR_ID;
  const voiceId = process.env.HEYGEN_VOICE_ID;
  if (!lookId) throw new Error('HEYGEN_AVATAR_ID (or HEYGEN_AVATARS) not set');
  if (!voiceId) throw new Error('HEYGEN_VOICE_ID not set');
  return { look_id: lookId, voice_id: voiceId };
}

export async function createProductReviewVideo(
  script: string,
  campaignId: string,
  productImages: string[] = []
): Promise<HeyGenVideoJob> {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error('HEYGEN_API_KEY not set');

  const { look_id: avatarId, voice_id: voiceId, name: avatarName } = pickAvatar();
  if (avatarName) {
    console.log(`[heygen] using avatar=${avatarName} look=${avatarId.slice(0, 8)}…`);
  }

  const callbackUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/marketing/heygen-webhook`
    : process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/marketing/heygen-webhook`
    : null;

  // HeyGen requires JPEG/PNG backgrounds — webp from Supabase is auto-proxied
  // through wsrv.nl by getProductImages(). Cap at 3 scenes so a 60-75s script
  // doesn't get split into thumbnail-length chunks.
  const usableImages = productImages
    .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    .slice(0, 3);

  // Multi-scene rotation: each scene gets a different product image as the
  // background and a different ~1/N chunk of the script. The avatar is a
  // small circle inset so the product is the visual hero, not the talking
  // head. Falls back to single-scene with a dark gradient if no images.
  const scenes = usableImages.length > 0
    ? splitScript(script, usableImages.length)
    : [script];

  const videoInputs = scenes.map((sceneScript, i) => {
    const bgImage = usableImages[i] ?? usableImages[0]; // tail scenes reuse last
    // Yali / Rafael are Photo Avatars (HeyGen Instant/Photo type), so
    // character.type must be 'talking_photo' with talking_photo_id —
    // 'avatar' / avatar_id is reserved for HeyGen's stock studio avatars.
    return {
      character: {
        type: 'talking_photo' as const,
        talking_photo_id: avatarId,
        talking_photo_style: usableImages.length > 0 ? 'circle' : 'square',
        talking_style: 'expressive' as const,
      },
      voice: {
        type: 'text' as const,
        input_text: sceneScript,
        voice_id: voiceId,
        speed: 0.95,
      },
      background: bgImage
        ? { type: 'image' as const, url: bgImage, fit: 'cover' as const }
        : { type: 'color' as const, value: '#0f172a' },
    };
  });

  const payload: Record<string, unknown> = {
    video_inputs: videoInputs,
    // 9:16 vertical for Instagram Reels / YouTube Shorts. Old 16:9 horizontal
    // got letterboxed on IG and looked tiny on phones.
    dimension: { width: 1080, height: 1920 },
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

// Split a script into N roughly-equal parts on sentence boundaries, so each
// HeyGen scene gets a coherent paragraph instead of mid-sentence cuts.
function splitScript(script: string, parts: number): string[] {
  if (parts <= 1) return [script];
  const sentences = script.match(/[^.!?]+[.!?]+\s*/g);
  if (!sentences || sentences.length < parts) return [script];
  const perPart = Math.ceil(sentences.length / parts);
  const out: string[] = [];
  for (let i = 0; i < parts; i++) {
    const chunk = sentences.slice(i * perPart, (i + 1) * perPart).join('').trim();
    if (chunk.length > 0) out.push(chunk);
  }
  return out.length > 0 ? out : [script];
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
