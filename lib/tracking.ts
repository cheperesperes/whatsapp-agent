/**
 * Multi-carrier delivery tracking via AfterShip — track by number, NO carrier
 * account required. Oiikon doesn't ship (PECRON ships from its own FedEx account);
 * we only need "is this tracking number delivered yet?". AfterShip tracks any
 * FedEx/UPS/USPS/DHL number by number and auto-detects the courier, on a free tier.
 *
 * Model: you CREATE a tracking once (AfterShip then polls the carrier async), and
 * READ it back later by its AfterShip id. We stash that id on the order
 * (orders.fulfillment_data.aftership_id) so the cron can re-read without a lookup.
 *
 * Env-gated: returns null on missing AFTERSHIP_API_KEY or any error — the caller
 * skips that order and never throws. Built to the AfterShip Tracking API 2026-01
 * (header `as-api-key`, version in the path); response parsing is defensive across
 * envelope shapes so a version bump won't silently break it.
 */
const VERSION = process.env.AFTERSHIP_API_VERSION || '2026-01';
const BASE = `https://api.aftership.com/tracking/${VERSION}`;

export function trackingConfigured(): boolean {
  return Boolean(process.env.AFTERSHIP_API_KEY);
}

/** Map our stored carrier label → AfterShip courier slug. Undefined = auto-detect. */
export function carrierSlug(carrier: string | null | undefined): string | undefined {
  const c = (carrier ?? '').toLowerCase();
  if (c.includes('fedex')) return 'fedex';
  if (c.includes('ups')) return 'ups';
  if (c.includes('usps')) return 'usps';
  if (c.includes('dhl')) return 'dhl';
  return undefined;
}

export interface TrackingState {
  id: string | null;
  tag: string | null; // AfterShip status tag: Delivered | InTransit | OutForDelivery | …
  delivered: boolean;
  deliveredAt: string | null;
}

function isDeliveredTag(tag: string | null): boolean {
  return (tag ?? '').toLowerCase() === 'delivered';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseTracking(json: unknown): TrackingState | null {
  // Single-tracking responses have historically been wrapped as
  // { meta, data: { tracking: {...} } }; tolerate flatter shapes too.
  const root = asRecord(json);
  if (!root) return null;
  const t =
    asRecord(asRecord(root.data)?.tracking) ?? asRecord(root.tracking) ?? asRecord(root.data) ?? root;
  const tag = typeof t.tag === 'string' ? t.tag : null;
  const deliveredAt =
    typeof t.shipment_delivery_date === 'string'
      ? t.shipment_delivery_date
      : typeof t.delivered_at === 'string'
        ? t.delivered_at
        : null;
  return {
    id: typeof t.id === 'string' ? t.id : null,
    tag,
    delivered: isDeliveredTag(tag),
    deliveredAt,
  };
}

async function afterShip(path: string, init: RequestInit): Promise<unknown | null> {
  const key = process.env.AFTERSHIP_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'as-api-key': key,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    // 4xx/5xx still parse — "already exists" responses can carry the tracking.
    const json = await res.json().catch(() => null);
    if (!res.ok && res.status !== 409) {
      console.warn(`[tracking] AfterShip ${init.method} ${path} → ${res.status}`);
    }
    return json;
  } catch (e) {
    console.warn(`[tracking] AfterShip request failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Create an AfterShip tracking for a number. Returns its id + current tag (often
 *  "Pending" on first create — AfterShip fetches the carrier asynchronously). */
export async function createTracking(
  trackingNumber: string,
  slug?: string,
): Promise<TrackingState | null> {
  if (!trackingConfigured()) return null;
  const body: Record<string, string> = { tracking_number: trackingNumber };
  if (slug) body.slug = slug;
  const json = await afterShip('/trackings', { method: 'POST', body: JSON.stringify(body) });
  return json ? parseTracking(json) : null;
}

/** Read a tracking's current state by its AfterShip id. */
export async function getTracking(id: string): Promise<TrackingState | null> {
  if (!trackingConfigured()) return null;
  const json = await afterShip(`/trackings/${encodeURIComponent(id)}`, { method: 'GET' });
  return json ? parseTracking(json) : null;
}
