/**
 * Multi-platform publisher
 *
 * Publishes to: Facebook Page, Instagram (Reels), YouTube.
 * Never touches customer data — only uses marketing_content from DB.
 *
 * Facebook Groups: we build a ready-to-paste WhatsApp message for Eduardo
 * so he can post to groups himself (Meta API does not allow fully automated
 * group posting without special review approval).
 */

const META_API = 'https://graph.facebook.com/v21.0';

// ── Facebook Page ─────────────────────────────────────────────────────────────

export async function publishToFacebook(
  postText: string,
  videoUrl: string | null
): Promise<{ post_id: string }> {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) throw new Error('META_PAGE_ID or META_PAGE_ACCESS_TOKEN not set');

  if (videoUrl) {
    // Post as video (much higher organic reach than text-only)
    const res = await fetch(`${META_API}/${pageId}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_url: videoUrl,
        description: postText,
        access_token: token,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Facebook video post failed (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { id: string };
    return { post_id: data.id };
  }

  // Text/link post fallback
  const res = await fetch(`${META_API}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: postText,
      access_token: token,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook feed post failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { id: string };
  return { post_id: data.id };
}

// ── Instagram Reels ────────────────────────────────────────────────────────────

export async function publishToInstagram(
  caption: string,
  videoUrl: string | null
): Promise<{ post_id: string } | null> {
  const igAccountId = process.env.META_IG_ACCOUNT_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!igAccountId || !token) return null; // Instagram is optional

  if (!videoUrl) return null; // Instagram reels require video

  // Step 1: Create media container
  const containerRes = await fetch(`${META_API}/${igAccountId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: token,
    }),
  });

  if (!containerRes.ok) {
    const err = await containerRes.text();
    console.error(`[marketing] Instagram container creation failed: ${err}`);
    return null; // Instagram failure is non-fatal
  }

  const container = (await containerRes.json()) as { id: string };

  // Wait for video to process on Meta's side (poll up to 60s)
  let mediaReady = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(
      `${META_API}/${container.id}?fields=status_code&access_token=${token}`
    );
    if (statusRes.ok) {
      const s = (await statusRes.json()) as { status_code?: string };
      if (s.status_code === 'FINISHED') {
        mediaReady = true;
        break;
      }
      if (s.status_code === 'ERROR') break;
    }
  }

  if (!mediaReady) {
    console.warn('[marketing] Instagram reel processing timed out');
    return null;
  }

  // Step 2: Publish the container
  const publishRes = await fetch(`${META_API}/${igAccountId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: container.id,
      access_token: token,
    }),
  });

  if (!publishRes.ok) {
    const err = await publishRes.text();
    console.error(`[marketing] Instagram publish failed: ${err}`);
    return null;
  }

  const published = (await publishRes.json()) as { id: string };
  return { post_id: published.id };
}

// ── YouTube ───────────────────────────────────────────────────────────────────

export async function publishToYouTube(
  videoUrl: string,
  title: string,
  description: string,
  tags: string[]
): Promise<{ video_id: string } | null> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[marketing] YouTube credentials not set — skipping YouTube upload');
    return null;
  }

  // Get fresh access token from refresh token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    console.error('[marketing] YouTube token refresh failed');
    return null;
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Download video from HeyGen and stream upload to YouTube
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok || !videoRes.body) {
    console.error('[marketing] Could not download HeyGen video for YouTube upload');
    return null;
  }

  // Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          tags: tags.slice(0, 15),
          categoryId: '22', // People & Blogs
          defaultLanguage: 'es',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) {
    console.error('[marketing] YouTube did not return upload URL');
    return null;
  }

  // Stream upload
  const videoBuffer = await videoRes.arrayBuffer();
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoBuffer.byteLength),
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error(`[marketing] YouTube upload failed: ${err}`);
    return null;
  }

  const uploaded = (await uploadRes.json()) as { id: string };
  return { video_id: uploaded.id };
}

// ── Groups message for Eduardo ────────────────────────────────────────────────

export function buildGroupsWhatsAppMessage(
  facebookPost: string,
  groups: Array<{ name: string; url: string }>,
  dailyTheme: string
): string {
  const topGroups = groups.slice(0, 8);
  const groupList = topGroups
    .map((g, i) => `${i + 1}. ${g.name}\n   ${g.url}`)
    .join('\n');

  return (
    `📣 *Grupos de Facebook — ${dailyTheme}*\n\n` +
    `Copia y pega este mensaje en cada grupo:\n\n` +
    `---\n${facebookPost.slice(0, 600)}...\n---\n\n` +
    `*Grupos sugeridos (${topGroups.length}):*\n${groupList}\n\n` +
    `Responde *GRUPOS OK* cuando hayas publicado en los grupos.`
  );
}
