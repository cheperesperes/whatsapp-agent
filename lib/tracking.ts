/**
 * Multi-carrier delivery tracking via 17TRACK — track by number, NO carrier
 * account, free tier (100 registrations/month; status polling after that is free).
 * Oiikon doesn't ship (PECRON ships from its own FedEx account); we only need
 * "is this tracking number delivered yet?". 17TRACK tracks any FedEx/UPS/USPS/DHL
 * number and auto-detects the courier.
 *
 * Model: REGISTER a number once (costs 1 of the monthly free quota), then read its
 * status as often as you want for free. We flag the registration on the order
 * (orders.fulfillment_data.st_registered) so the cron registers each number once.
 *
 * Env-gated: returns false/null on missing SEVENTEENTRACK_API_KEY or any error — the
 * caller skips that order and never throws. Built to the 17TRACK API v2.2 (header
 * `17token`); response parsing is defensive so a shape change won't silently break it.
 */
const BASE = process.env.SEVENTEENTRACK_API_BASE || 'https://api.17track.net/track/v2.2';

export function trackingConfigured(): boolean {
  return Boolean(process.env.SEVENTEENTRACK_API_KEY);
}

async function call(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const key = process.env.SEVENTEENTRACK_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { '17token': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) console.warn(`[tracking] 17track ${path} → HTTP ${res.status}`);
    return json;
  } catch (e) {
    console.warn(`[tracking] 17track request failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pull the {accepted, rejected} arrays out of a 17track response, tolerating shape. */
function lists(json: Record<string, unknown> | null): {
  accepted: Record<string, unknown>[];
  rejected: Record<string, unknown>[];
} {
  const data = asRecord(json?.data) ?? {};
  const accepted = Array.isArray(data.accepted) ? (data.accepted as Record<string, unknown>[]) : [];
  const rejected = Array.isArray(data.rejected) ? (data.rejected as Record<string, unknown>[]) : [];
  return { accepted, rejected };
}

/**
 * Register a tracking number so 17track starts monitoring it. Returns true if it's
 * now registered (freshly accepted OR already registered before). False on a real
 * rejection (invalid number, out of monthly quota) — caller should retry later.
 */
export async function registerTracking(number: string, carrier?: number): Promise<boolean> {
  const json = await call('/register', [{ number, ...(carrier ? { carrier } : {}) }]);
  if (!json) return false;
  const { accepted, rejected } = lists(json);
  if (accepted.some((a) => String(a.number) === String(number))) return true;
  const r = rejected.find((x) => String(x.number) === String(number));
  if (r) {
    const err = asRecord(r.error);
    const msg = String(err?.message ?? '').toLowerCase();
    // "already registered" is success for our purposes — proceed to poll it.
    if (msg.includes('already') || msg.includes('exist')) return true;
    console.warn(`[tracking] 17track register rejected ${number}: ${msg || JSON.stringify(err)}`);
  }
  return false;
}

export interface TrackingState {
  delivered: boolean;
  status: string | null;
}

/** Read a registered number's current delivery state. Null if not found / error. */
export async function getDeliveryStatus(number: string): Promise<TrackingState | null> {
  const json = await call('/gettrackinfo', [{ number }]);
  if (!json) return null;
  const { accepted } = lists(json);
  if (!accepted.length) return null;
  const item = accepted.find((a) => String(a.number) === String(number)) ?? accepted[0];
  const trackInfo = asRecord(item.track_info) ?? {};
  const latest = trackInfo.latest_status;
  const latestRec = asRecord(latest);
  const status =
    typeof latest === 'string'
      ? latest
      : typeof latestRec?.status === 'string'
        ? (latestRec.status as string)
        : null;
  const sub = typeof latestRec?.sub_status === 'string' ? (latestRec.sub_status as string) : '';
  const delivered = /delivered/i.test(status ?? '') || /delivered/i.test(sub);
  return { delivered, status };
}
