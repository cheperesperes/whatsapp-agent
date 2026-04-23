/**
 * TikTok Content Posting API
 *
 * Posts HeyGen videos as TikTok videos via the Content Posting API.
 * Requires TikTok for Business account with Content Posting API access.
 *
 * Auth flow: OAuth2 with refresh token (one-time setup via /api/marketing/tiktok-auth)
 */

const TIKTOK_API = 'https://open.tiktokapis.com/v2';

async function refreshTikTokToken(): Promise<string> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;

  if (!clientKey || !clientSecret || !refreshToken) {
    throw new Error('TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, or TIKTOK_REFRESH_TOKEN not set');
  }

  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok token refresh failed: ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data: { access_token: string } };
  return data.data.access_token;
}

export interface TikTokPostResult {
  publish_id: string;
}

export async function postVideoToTikTok(
  videoUrl: string,
  caption: string,
  title: string
): Promise<TikTokPostResult | null> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) {
    console.warn('[tiktok] TIKTOK_CLIENT_KEY not set — skipping TikTok');
    return null;
  }

  let token: string;
  try {
    token = await refreshTikTokToken();
  } catch (e) {
    console.error('[tiktok] Token refresh failed:', e);
    return null;
  }

  // TikTok Content Posting API — pull from URL
  const initRes = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: `${title.slice(0, 150)} #OiikonSolar #EnergíaSolar #LatinosUSA #Cuba #Venezuela`,
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    }),
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    console.error(`[tiktok] Post init failed (${initRes.status}): ${err.slice(0, 300)}`);
    return null;
  }

  const initData = (await initRes.json()) as {
    data: { publish_id: string };
    error: { code: string; message: string };
  };

  if (initData.error?.code !== 'ok' && initData.error?.code !== undefined) {
    console.error('[tiktok] API error:', initData.error.message);
    return null;
  }

  return { publish_id: initData.data.publish_id };
}

export async function getTikTokPostStatus(publishId: string): Promise<string> {
  const token = await refreshTikTokToken();

  const res = await fetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  if (!res.ok) return 'unknown';

  const data = (await res.json()) as {
    data: { status: string };
  };

  return data.data?.status ?? 'unknown';
}
