/**
 * FedEx Track API client — OAuth2 (client_credentials) + Track by tracking number.
 *
 * Used by the delivery-alerts cron to auto-detect when a FedEx shipment is
 * delivered (so it can flip the order to `delivered` and fire the "📦 it arrived"
 * WhatsApp). Cost-free with a FedEx developer account.
 *
 * Env (set in Vercel — DORMANT until both are present):
 *   FEDEX_API_KEY     — the project's API Key (client_id)
 *   FEDEX_SECRET_KEY  — the project's Secret Key (client_secret)
 *   FEDEX_API_BASE    — optional; defaults to production. Sandbox:
 *                       https://apis-sandbox.fedex.com
 *
 * Everything returns null on missing creds / any error — the caller treats that
 * as "status unknown, skip" and never throws.
 */

const FEDEX_BASE = process.env.FEDEX_API_BASE || 'https://apis.fedex.com';

// Module-level token cache (FedEx tokens last ~1h; refresh with a 60s safety margin).
let cachedToken: { token: string; expiresAt: number } | null = null;

export function fedexConfigured(): boolean {
  return Boolean(process.env.FEDEX_API_KEY && process.env.FEDEX_SECRET_KEY);
}

async function getFedexToken(now: number): Promise<string | null> {
  if (!fedexConfigured()) return null;
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  try {
    const res = await fetch(`${FEDEX_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.FEDEX_API_KEY as string,
        client_secret: process.env.FEDEX_SECRET_KEY as string,
      }),
    });
    if (!res.ok) {
      console.warn(`[fedex] oauth http ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    cachedToken = { token: j.access_token, expiresAt: now + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  } catch (e) {
    console.warn('[fedex] oauth error', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export interface FedexStatus {
  delivered: boolean;
  statusCode: string | null; // e.g. 'DL' (Delivered), 'OD' (Out for Delivery), 'IT' (In Transit)
  description: string | null; // human label, e.g. "Delivered"
  deliveredAt: string | null; // ISO timestamp when delivered, if available
}

// Minimal shape of the bits of the Track response we read (avoids `any`).
interface TrackResponse {
  output?: {
    completeTrackResults?: Array<{
      trackResults?: Array<{
        latestStatusDetail?: { code?: string; statusByLocale?: string; description?: string };
        dateAndTimes?: Array<{ type?: string; dateTime?: string }>;
      }>;
    }>;
  };
}

/**
 * Look up the latest status for one FedEx tracking number. Returns null when
 * FedEx isn't configured or the call fails (caller skips, never throws).
 */
export async function trackFedex(trackingNumber: string): Promise<FedexStatus | null> {
  const token = await getFedexToken(Date.now());
  if (!token) return null;
  try {
    const res = await fetch(`${FEDEX_BASE}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
      },
      body: JSON.stringify({
        includeDetailedScans: false,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      }),
    });
    if (!res.ok) {
      console.warn(`[fedex] track http ${res.status} for ${trackingNumber}`);
      return null;
    }
    const j = (await res.json()) as TrackResponse;
    const tr = j.output?.completeTrackResults?.[0]?.trackResults?.[0];
    if (!tr) return null;
    const statusCode = tr.latestStatusDetail?.code ?? null;
    const description = tr.latestStatusDetail?.statusByLocale ?? tr.latestStatusDetail?.description ?? null;
    const delivered = statusCode === 'DL' || /delivered/i.test(String(description ?? ''));
    let deliveredAt: string | null = null;
    if (delivered) {
      const dt = (tr.dateAndTimes ?? []).find((d) => /DELIVERY/i.test(String(d?.type ?? '')));
      deliveredAt = dt?.dateTime ?? null;
    }
    return { delivered, statusCode, description, deliveredAt };
  } catch (e) {
    console.warn('[fedex] track error', e instanceof Error ? e.message : String(e));
    return null;
  }
}
