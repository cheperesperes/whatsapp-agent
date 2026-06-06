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
  loadStorefrontProductsBySku,
  selectBestOffer,
  createServiceClient,
  type Offer,
} from './supabase';
import {
  createPayLink,
  isPayPalConfigured,
  getPayPalOrder,
  type PayLinkItem,
  type CaptureResult,
} from './marketing/paypal';

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
  // agent_product_catalog is the source of truth. For any requested SKU NOT in
  // it, fall back to the storefront `products` table (read-only) so Sol can
  // pay-link any active website product (e.g. accessories). Agent-catalog items
  // keep their (intentionally different) price; we never write a price here.
  type ResolvedProduct = {
    sku: string; name: string; sell_price: number;
    discount_percentage: number | null; in_stock: boolean; brand: string | null;
  };
  const bySku = new Map<string, ResolvedProduct>(
    catalog.map((p) => [
      p.sku.toLowerCase(),
      { sku: p.sku, name: p.name, sell_price: p.sell_price, discount_percentage: p.discount_percentage, in_stock: p.in_stock, brand: p.brand },
    ]),
  );
  const missingSkus = lines
    .map((l) => (l.sku || '').trim())
    .filter((s) => s && !bySku.has(s.toLowerCase()));
  if (missingSkus.length) {
    for (const fp of await loadStorefrontProductsBySku(missingSkus)) {
      bySku.set(fp.sku.toLowerCase(), {
        sku: fp.sku, name: fp.name, sell_price: fp.sell_price,
        discount_percentage: fp.discount_percentage, in_stock: fp.in_stock, brand: fp.brand,
      });
    }
  }

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
      const best = selectBestOffer(unit, p.brand ?? '', cost, couponOffers);
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

// ── Record the sale as an order ─────────────────────────────────────────────

export interface RecordOrderResult {
  ok: boolean;
  orderNumber?: string;
  alreadyExisted?: boolean;
  shippingIncomplete?: boolean;
  error?: string;
}

/**
 * After a pay-link is captured, record it as a real `orders` row. The
 * storefront's existing DB triggers then auto-generate the order number, EMAIL
 * THE ADMIN (notify_admin_new_order), send the order email/SMS, and populate
 * financials — same as a website checkout. Best-effort + idempotent (keyed on
 * paypal_order_id) so it can NEVER block the payment or create duplicates.
 */
export async function recordPayLinkOrder(
  paypalOrderId: string,
  capture: CaptureResult,
): Promise<RecordOrderResult> {
  try {
    const sb = createServiceClient();

    // Idempotent: never create two orders for the same PayPal order (the return
    // path and the webhook can both fire).
    const { data: existing } = await sb
      .from('orders')
      .select('order_number')
      .eq('paypal_order_id', paypalOrderId)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return { ok: true, alreadyExisted: true, orderNumber: (existing as { order_number?: string }).order_number };
    }

    const details = await getPayPalOrder(paypalOrderId);
    if (!details.ok) return { ok: false, error: details.error ?? 'order_details_unavailable' };

    // Map SKUs -> product_id (UUID) so the stock-decrement trigger can find them.
    const skus = details.items.map((i) => i.sku).filter(Boolean) as string[];
    const idBySku: Record<string, string> = {};
    if (skus.length) {
      const { data: prods } = await sb.from('products').select('id, sku').in('sku', skus);
      for (const r of (prods ?? []) as Array<{ id: string; sku: string }>) {
        idBySku[String(r.sku).toUpperCase()] = r.id;
      }
    }
    const items = details.items.map((i) => ({
      id: i.sku ? idBySku[i.sku.toUpperCase()] ?? null : null,
      sku: i.sku ?? null,
      name: i.name,
      quantity: i.quantity,
      price: i.unitPrice,
    }));

    const sh = details.shipping ?? {};
    const addr = sh?.address ?? {};
    // Flag if PayPal didn't return enough to ship (no street or no city).
    const shippingIncomplete = !addr?.address_line_1 || !addr?.admin_area_2;
    const shippingAddress = {
      fullName: sh?.name?.full_name ?? details.payerName ?? '',
      address: [addr?.address_line_1, addr?.address_line_2].filter(Boolean).join(', '),
      city: addr?.admin_area_2 ?? '',
      province: addr?.admin_area_1 ?? '',
      postalCode: addr?.postal_code ?? '',
      country: addr?.country_code ?? 'US',
      ship_to_cuba: false,
      source: 'whatsapp_paylink',
    };

    const subtotal = Math.round(Number(details.itemTotal || capture.amount || 0) * 100) / 100;
    const shippingCost = Math.round(Number(details.shippingTotal || 0) * 100) / 100;
    const total = Math.round((subtotal + shippingCost) * 100) / 100;

    const { data: inserted, error } = await sb
      .from('orders')
      .insert({
        // order_number auto-generated by the set_order_number trigger
        customer_email: details.payerEmail ?? 'sin-email@oiikon.com',
        customer_name: details.payerName ?? 'Cliente WhatsApp',
        customer_phone: details.payerPhone ?? null,
        shipping_address: shippingAddress,
        items,
        subtotal,
        shipping_cost: shippingCost,
        total,
        status: 'processing',
        payment_status: 'paid', // REQUIRED for the admin-alert trigger to fire
        payment_method: 'paypal',
        paypal_order_id: paypalOrderId,
        paypal_capture_id: capture.captureId ?? null,
        paid_at: new Date().toISOString(),
        readiness_status: 'yellow',
        complianceflag: 'unknown',
        is_ship_to_cuba: false,
        review_email_sent: false,
        notes:
          'WhatsApp pay-link order (Sol)' +
          (shippingIncomplete ? ' | ⚠️ DIRECCIÓN INCOMPLETA — confirmar con el cliente antes de enviar' : ''),
        data_segment: 'whatsapp_paylink',
      })
      .select('order_number')
      .single();

    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      orderNumber: (inserted as { order_number?: string } | null)?.order_number,
      shippingIncomplete,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
