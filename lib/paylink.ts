/**
 * Pay-by-link for Sol (WhatsApp) — the conversion close.
 *
 * Sol is a prompt-only agent (no tool-use), so to "send a payment link" it
 * emits a marker:
 *     [[PAYLINK items=SKU:qty,SKU:qty coupon=CODE]]
 * and the webhook calls `applyPayLinkMarkers()` to replace it with a REAL
 * PayPal tap-to-pay URL (guest card / PayPal / Apple Pay — no account).
 *
 * Pricing is computed HERE from the catalog (never from the LLM) and any
 * coupon is re-validated for margin safety via `selectBestOffer`, so a
 * hallucinated price or a margin-breaking code can never reach checkout.
 * This replaces the failure mode that lost the 2026-06-02 hot leads: Sol
 * pushing self-serve checkout / a dead human handoff / a broken app-preview URL.
 */

import {
  loadAgentCatalog,
  loadActiveOffers,
  loadProductCosts,
  selectBestOffer,
  type Offer,
} from './supabase';
import { createPayLink, isPayPalConfigured, type PayLinkItem } from './marketing/paypal';

export interface PayLinkLineRequest {
  sku: string;
  qty: number;
}

export interface BuildPayLinkResult {
  ok: boolean;
  url?: string;
  total?: number;
  summary?: string;
  error?: string;
}

const clampQty = (n: number) => Math.max(1, Math.min(20, Math.floor(Number(n) || 1)));

/**
 * Build a PayPal pay-link for one or more catalog SKUs. Price + coupon are
 * resolved server-side; an unknown/OOS SKU or unconfigured PayPal returns
 * `{ ok:false }` so the caller can fall back gracefully.
 */
export async function buildPayLink(
  lines: PayLinkLineRequest[],
  couponCode?: string | null,
): Promise<BuildPayLinkResult> {
  if (!isPayPalConfigured()) return { ok: false, error: 'paypal_not_configured' };
  if (!lines.length) return { ok: false, error: 'no_items' };

  const [catalog, offers, costs] = await Promise.all([
    loadAgentCatalog(),
    loadActiveOffers(),
    loadProductCosts(),
  ]);
  const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));

  // Restrict coupon validation to the exact code Sol quoted (if any).
  const couponOffers: Offer[] = couponCode
    ? offers.filter((o) => o.code.toLowerCase() === couponCode.toLowerCase())
    : [];

  const items: PayLinkItem[] = [];
  const summaryParts: string[] = [];

  for (const ln of lines) {
    const p = bySku.get((ln.sku || '').toLowerCase());
    if (!p || !p.in_stock) return { ok: false, error: `unknown_or_oos_sku:${ln.sku}` };

    const qty = clampQty(ln.qty);
    const disc = Math.max(0, Math.min(50, p.discount_percentage ?? 0));
    let unit = disc > 0 ? p.sell_price * (1 - disc / 100) : p.sell_price;

    // Apply the requested coupon ONLY if it is margin-safe for this product
    // (selectBestOffer enforces brand, min-order and the per-code margin floor).
    if (couponOffers.length) {
      const cost = costs[p.sku.toLowerCase()] ?? null;
      const best = selectBestOffer(unit, p.brand, cost, couponOffers);
      if (best) unit = best.finalPrice;
    }

    unit = Math.round(unit * 100) / 100;
    if (!(unit > 0)) return { ok: false, error: `bad_price:${p.sku}` };

    items.push({ name: p.name, sku: p.sku, unit_price: unit, qty });
    summaryParts.push(`${qty}× ${p.name} ($${unit.toFixed(2)})`);
  }

  const res = await createPayLink(items, {
    shippingFlat: 0, // free shipping to lower-48 US
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com',
    note: couponCode ? `WA pay-link · ${couponCode}` : 'WA pay-link',
  });
  if (!res.ok || !res.url) return { ok: false, error: res.error ?? 'paypal_failed' };

  return {
    ok: true,
    url: res.url,
    total: res.total,
    summary: `${summaryParts.join(' + ')} — total $${(res.total ?? 0).toFixed(2)}`,
  };
}

// ── Marker parsing + substitution ───────────────────────────────────────────

const PAYLINK_RE = /\[\[\s*PAYLINK\s+([^\]]+?)\s*\]\]/gi;

function parseMarker(inner: string): { lines: PayLinkLineRequest[]; coupon: string | null } {
  const itemsMatch = inner.match(/items=([^\s]+)/i);
  const couponMatch = inner.match(/coupon=([^\s]+)/i);
  const lines: PayLinkLineRequest[] = [];
  if (itemsMatch) {
    for (const pair of itemsMatch[1].split(',')) {
      const [sku, qty] = pair.split(':');
      if (sku && sku.trim()) lines.push({ sku: sku.trim(), qty: Number(qty) || 1 });
    }
  }
  const coupon =
    couponMatch && !/^(none|null|n\/a)$/i.test(couponMatch[1]) ? couponMatch[1].trim() : null;
  return { lines, coupon };
}

export interface ApplyPayLinkResult {
  text: string;
  built: number;
  failed: number;
  details: string[];
}

/**
 * Replace every [[PAYLINK …]] marker in an outgoing Sol message with a real
 * PayPal pay-link. A raw marker is NEVER left in the text — on failure it's
 * swapped for a soft "one moment" line so the customer never sees the marker.
 */
export async function applyPayLinkMarkers(
  text: string,
  lang: 'es' | 'en' = 'es',
): Promise<ApplyPayLinkResult> {
  const markers = [...text.matchAll(PAYLINK_RE)];
  if (markers.length === 0) return { text, built: 0, failed: 0, details: [] };

  const soft =
    lang === 'en'
      ? 'One moment — I’ll send your secure pay link right away. 🙏'
      : 'Un momento — te envío tu link de pago seguro enseguida. 🙏';

  let out = text;
  let built = 0;
  let failed = 0;
  const details: string[] = [];

  for (const m of markers) {
    let replacement = soft;
    try {
      const { lines, coupon } = parseMarker(m[1]);
      const r = await buildPayLink(lines, coupon);
      if (r.ok && r.url) {
        built++;
        details.push(`ok ${r.summary}`);
        replacement =
          lang === 'en'
            ? `💳 Secure pay link (card / PayPal / Apple Pay — no account needed):\n${r.url}`
            : `💳 Tu link de pago seguro (tarjeta / PayPal / Apple Pay — sin cuenta):\n${r.url}`;
      } else {
        failed++;
        details.push(`fail ${r.error}`);
      }
    } catch (e) {
      failed++;
      details.push(`err ${e instanceof Error ? e.message : String(e)}`);
    }
    out = out.replace(m[0], replacement);
  }

  return { text: out, built, failed, details };
}
