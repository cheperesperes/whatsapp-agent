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
  loadOffersByCode,
  loadProductCosts,
  loadStorefrontProductsBySku,
  selectBestOffer,
  createServiceClient,
  getOrCreateConversation,
  getConversationByPhone,
  markConversationWon,
  storeMessage,
  type Offer,
} from './supabase';
import {
  createPayLink,
  isPayPalConfigured,
  getPayPalOrder,
  PAYLINK_TAG,
  type PayLinkItem,
  type CaptureResult,
} from './marketing/paypal';
import { sendWhatsAppMessage } from './whatsapp';

export interface PayLinkLineRequest {
  sku: string;
  qty: number;
  /** Price-match: a competitor unit price to sell at INSTEAD of the catalog
   * price. Server-enforced — buildPayLink rejects it if it falls below the
   * margin floor (cost / (1 − PRICE_MATCH_MIN_MARGIN_PCT/100)), so Sol can
   * never undercut below a safe margin no matter what it emits. */
  overrideUnitPrice?: number;
}

export interface BuildPayLinkResult {
  ok: boolean;
  url?: string;
  total?: number;
  summary?: string;
  error?: string;
}

const clampQty = (n: number) => Math.max(1, Math.min(20, Math.floor(Number(n) || 1)));

// US sales tax. Oiikon collects only where it has nexus — FL (~7%, matching the
// storefront). Sol asks a low-friction "¿envío a Florida?" yes/no and sets fl=si
// in the marker; we tax ONLY Florida. Add states here if nexus ever expands.
const FL_SALES_TAX_RATE = 0.07;

// Price-match floor. Sol may match a competitor's verified comparable price,
// but NEVER below this gross-margin floor: price ≥ cost / (1 − M/100). M defaults
// to 12% (covers the PayPal fee + a small net margin — "break-even + a bit", no
// race to the bottom). If cost is unknown we can't prove the floor → no match.
const PRICE_MATCH_MIN_MARGIN_PCT = Number(process.env.PRICE_MATCH_MIN_MARGIN_PCT ?? 12);
export function priceMatchFloor(cost: number | null | undefined): number | null {
  if (cost == null || !(cost > 0)) return null;
  const m = Math.max(0, Math.min(45, PRICE_MATCH_MIN_MARGIN_PCT));
  return Math.round((cost / (1 - m / 100)) * 100) / 100;
}

/**
 * Build a PayPal pay-link for one or more catalog SKUs. Price + coupon are
 * resolved server-side; an unknown/OOS SKU or unconfigured PayPal returns
 * `{ ok:false }` so the caller can fall back gracefully.
 */
export async function buildPayLink(
  lines: PayLinkLineRequest[],
  couponCode?: string | null,
  isFlorida = false,
  waPhone?: string,
  lang: 'es' | 'en' = 'es',
): Promise<BuildPayLinkResult> {
  if (!lines.length) return { ok: false, error: 'no_items' };

  // VOLUME AUTO-OFFER (Ed 2026-06-30): a multi-unit cart earns a deeper discount,
  // tiered by TOTAL quantity — 2 units → up to 8% off, 3+ → up to 12% off. We offer a
  // LADDER (VOL5/VOL8/VOL12) capped by quantity and let selectBestOffer pick the
  // LARGEST tier each SKU's margin can safely absorb: thin-margin units auto-cap to a
  // smaller tier (or none) while healthy-margin units get the full ceiling. Loaded by
  // quantity and OUTSIDE the presentable allowlist, so Sol never auto-pitches a multi-
  // unit price to a single-unit buyer. Margin is re-checked per SKU below, so the
  // discount can never breach the floor (cost stays server-side, never in the prompt).
  const totalQty = lines.reduce((s, l) => s + clampQty(l.qty), 0);
  const volumeCodes = totalQty >= 3 ? ['VOL12', 'VOL8', 'VOL5']
                    : totalQty >= 2 ? ['VOL8', 'VOL5']
                    : [];

  const [catalog, offers, costs, volumeOffers] = await Promise.all([
    loadAgentCatalog(),
    loadActiveOffers(),
    loadProductCosts(),
    volumeCodes.length ? loadOffersByCode(volumeCodes) : Promise.resolve([] as Offer[]),
  ]);
  // agent_product_catalog is the source of truth. For any requested SKU NOT in
  // it, fall back to the storefront `products` table (read-only) so Sol can
  // pay-link any active website product (e.g. accessories). Agent-catalog items
  // keep their (intentionally different) price; we never write a price here.
  type ResolvedProduct = {
    sku: string; name: string; sell_price: number;
    discount_percentage: number | null; in_stock: boolean; brand: string | null;
    slug: string | null;
  };
  const bySku = new Map<string, ResolvedProduct>(
    catalog.map((p) => [
      p.sku.toLowerCase(),
      { sku: p.sku, name: p.name, sell_price: p.sell_price, discount_percentage: p.discount_percentage, in_stock: p.in_stock, brand: p.brand, slug: (p as { slug?: string | null }).slug ?? null },
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
        slug: (fp as { slug?: string | null }).slug ?? null,
      });
    }
  }

  // Restrict coupon validation to the code(s) Sol quoted. Accept a single code
  // OR a comma-separated list (e.g. "HURRICANE5,PECRON7") so a multi-item / mixed-
  // brand combo can keep the best margin-safe coupon PER item: selectBestOffer
  // picks the largest safe saving for each product from this set independently.
  // Backward-compatible — a single code behaves exactly as before. Empty → none.
  const requestedCodes = (couponCode ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const couponOffers: Offer[] = [
    ...(requestedCodes.length
      ? offers.filter((o) => requestedCodes.includes(o.code.toLowerCase()))
      : []),
    // Quantity-earned volume code (empty for a single unit). Already margin-gated
    // per-SKU by selectBestOffer below — it wins over a smaller requested code.
    ...volumeOffers,
  ];

  const items: PayLinkItem[] = [];
  const summaryParts: string[] = [];
  let appliedCode: string | null = null; // promo actually applied to the primary item

  for (const ln of lines) {
    const p = bySku.get((ln.sku || '').toLowerCase());
    if (!p || !p.in_stock) return { ok: false, error: `unknown_or_oos_sku:${ln.sku}` };

    const qty = clampQty(ln.qty);
    const disc = Math.max(0, Math.min(50, p.discount_percentage ?? 0));
    let unit = disc > 0 ? p.sell_price * (1 - disc / 100) : p.sell_price;
    const cost = costs[p.sku.toLowerCase()] ?? null;

    if (ln.overrideUnitPrice != null) {
      // PRICE MATCH — sell at the competitor price, but ONLY if it clears the
      // margin floor (server-authoritative; cost never leaves the server).
      const floor = priceMatchFloor(cost);
      if (floor == null) return { ok: false, error: `match_no_cost:${p.sku}` };
      if (ln.overrideUnitPrice < floor - 0.01) {
        return { ok: false, error: `match_below_floor:${p.sku}` };
      }
      unit = ln.overrideUnitPrice; // coupon does NOT stack on a match
    } else if (couponOffers.length) {
      // Apply the best margin-safe coupon for this product (selectBestOffer enforces
      // brand, min-order and the per-code margin floor). For a multi-unit cart this
      // is where VOL2/VOL3 win over any smaller requested code.
      const best = selectBestOffer(unit, p.brand ?? '', cost, couponOffers);
      if (best) {
        unit = best.finalPrice;
        if (appliedCode == null) appliedCode = best.code;
      }
    }

    unit = Math.round(unit * 100) / 100;
    if (!(unit > 0)) return { ok: false, error: `bad_price:${p.sku}` };

    items.push({ name: p.name, sku: p.sku, unit_price: unit, qty });
    summaryParts.push(`${qty}× ${p.name} ($${unit.toFixed(2)})`);
  }

  // Sales tax: FL only (post-coupon subtotal). Non-FL → 0.
  const taxableSubtotal = items.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const tax = isFlorida ? Math.round(taxableSubtotal * FL_SALES_TAX_RATE * 100) / 100 : 0;

  // PAYMENT LINK = the storefront PRODUCT PAGE (Stripe checkout: card / Affirm /
  // Apple Pay / Google Pay / PayPal — the buyer picks). We no longer mint a
  // PayPal-only pay-link (it lacked Affirm + Apple/Google Pay). A price-match
  // override price can't be honored by a fixed-price product page, so it degrades.
  if (lines.some((l) => l.overrideUnitPrice != null)) {
    return { ok: false, error: 'pricematch_unsupported_on_product_link' };
  }
  const primary = bySku.get((lines[0]?.sku || '').toLowerCase());
  if (!primary?.slug) return { ok: false, error: `no_product_slug:${lines[0]?.sku ?? '?'}` };
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com').replace(/\/+$/, '');
  // Prefer the code we actually validated (incl. the volume tier); fall back to the
  // raw quoted code for backward-compat. Carry quantity so a multi-unit order opens
  // pre-loaded at checkout (harmless query param if the storefront ignores it).
  const promo = (appliedCode ?? couponCode ?? '').trim();
  const params = [
    promo ? `promo=${encodeURIComponent(promo)}` : '',
    totalQty > 1 ? `qty=${totalQty}` : '',
  ].filter(Boolean).join('&');
  const url = `${appUrl}/product/${primary.slug}${params ? `?${params}` : ''}`;
  const grand = Math.round((taxableSubtotal + tax) * 100) / 100;

  return {
    ok: true,
    url,
    total: grand,
    summary: `${summaryParts.join(' + ')}${tax > 0 ? ` + imp. FL ~$${tax.toFixed(2)}` : ''} — ~$${grand.toFixed(2)} (storefront checkout)`,
  };
}

// ── Marker parsing + substitution ───────────────────────────────────────────

const PAYLINK_RE = /\[\[\s*PAYLINK\s+([^\]]+?)\s*\]\]/gi;

function parseMarker(inner: string): { lines: PayLinkLineRequest[]; coupon: string | null; isFlorida: boolean } {
  const itemsMatch = inner.match(/items=([^\s]+)/i);
  const couponMatch = inner.match(/coupon=([^\s]+)/i);
  const flMatch = inner.match(/fl=([^\s]+)/i);
  const lines: PayLinkLineRequest[] = [];
  if (itemsMatch) {
    for (const pair of itemsMatch[1].split(',')) {
      const [sku, qty] = pair.split(':');
      if (sku && sku.trim()) lines.push({ sku: sku.trim(), qty: Number(qty) || 1 });
    }
  }
  const coupon =
    couponMatch && !/^(none|null|n\/a)$/i.test(couponMatch[1]) ? couponMatch[1].trim() : null;
  // fl=si|yes|1|true|fl|florida → ship to Florida (apply FL sales tax). Default no.
  const isFlorida = flMatch ? /^(s[ií]|si|yes|y|1|true|fl|florida)$/i.test(flMatch[1].trim()) : false;
  return { lines, coupon, isFlorida };
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
  waPhone?: string,
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
      const { lines, coupon, isFlorida } = parseMarker(m[1]);
      const r = await buildPayLink(lines, coupon, isFlorida, waPhone, lang);
      if (r.ok && r.url) {
        built++;
        details.push(`ok ${r.summary}`);
        replacement =
          lang === 'en'
            ? `💳 Secure checkout — pick how you pay (card / Affirm monthly / Apple Pay / Google Pay / PayPal, no account):\n${r.url}`
            : `💳 Pago seguro — elija cómo pagar (tarjeta / Affirm a meses / Apple Pay / Google Pay / PayPal, sin cuenta):\n${r.url}`;
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

// ── Price match ─────────────────────────────────────────────────────────────
// Sol emits [[PRICEMATCH sku=SKU competitor=PRICE fl=si|no]] when a customer has
// shown a genuinely comparable unit at a lower price. The SERVER decides the
// outcome (cost/floor never reach the LLM) and writes the whole customer-facing
// line, so Sol can't pre-promise a number it can't honor:
//   • already_cheaper — our price ≤ theirs → affirm we're already as good/better.
//   • match           — floor ≤ theirs < ours → match to their price (margin-safe).
//   • hold            — theirs < floor (or cost unknown) → hold at our price + value.
const PRICEMATCH_RE = /\[\[\s*PRICEMATCH\s+([^\]]+?)\s*\]\]/gi;

function parsePriceMatchMarker(inner: string): { sku: string; competitor: number; isFlorida: boolean } | null {
  const skuM = inner.match(/sku=([^\s]+)/i);
  const compM = inner.match(/competitor=\$?([0-9]+(?:[.,][0-9]+)?)/i);
  const flM = inner.match(/fl=([^\s]+)/i);
  if (!skuM || !compM) return null;
  const competitor = Number(compM[1].replace(',', '.'));
  if (!(competitor > 0)) return null;
  const isFlorida = flM ? /^(s[ií]|si|yes|y|1|true|fl|florida)$/i.test(flM[1].trim()) : false;
  return { sku: skuM[1].trim(), competitor, isFlorida };
}

function framePriceMatch(
  lang: 'es' | 'en',
  outcome: 'already_cheaper' | 'match' | 'hold',
  ourPrice: number,
  matchedPrice: number,
  url: string,
): string {
  const link = lang === 'en'
    ? `👉 Secure checkout (card / PayPal / Apple Pay — no account):\n${url}`
    : `👉 Pague seguro (tarjeta / PayPal / Apple Pay — sin cuenta):\n${url}`;
  if (lang === 'en') {
    if (outcome === 'already_cheaper')
      return `Good news — our price is already as good or better: *$${ourPrice.toFixed(2)}*, with US-backed warranty + LiFePO4 (~10-yr life). ${link}`;
    if (outcome === 'match')
      return `🤝 Done — I'll match it: *$${matchedPrice.toFixed(2)}* for the same unit, plus warranty handled here in the US and direct support. ${link}`;
    return `My best on this one is *$${ourPrice.toFixed(2)}* — I can't go lower without dropping the US-backed warranty and support that a cheaper, shorter-life unit won't give you. ${link}`;
  }
  if (outcome === 'already_cheaper')
    return `¡Buena noticia! Nuestro precio ya es igual o mejor: *$${ourPrice.toFixed(2)}*, con garantía respaldada en EE.UU. + batería LiFePO4 (~10 años de vida). ${link}`;
  if (outcome === 'match')
    return `🤝 ¡Hecho, le igualo el precio! *$${matchedPrice.toFixed(2)}* por el mismo equipo, con garantía aquí en EE.UU. y soporte directo. ${link}`;
  return `Mi mejor precio en este equipo es *$${ourPrice.toFixed(2)}* — no puedo bajar más sin quitarle la garantía respaldada en EE.UU. y el soporte que una opción más barata y de menor duración no le da. ${link}`;
}

export async function applyPriceMatchMarkers(
  text: string,
  lang: 'es' | 'en' = 'es',
  waPhone?: string,
): Promise<ApplyPayLinkResult> {
  const markers = [...text.matchAll(PRICEMATCH_RE)];
  if (markers.length === 0) return { text, built: 0, failed: 0, details: [] };

  const soft = lang === 'en'
    ? 'One moment — let me check the best price I can do. 🙏'
    : 'Un momento — déjeme ver el mejor precio que le puedo dar. 🙏';

  const [catalog, costs] = await Promise.all([loadAgentCatalog(), loadProductCosts()]);
  let out = text, built = 0, failed = 0;
  const details: string[] = [];

  for (const m of markers) {
    let replacement = soft;
    try {
      const parsed = parsePriceMatchMarker(m[1]);
      if (!parsed) { failed++; details.push('pm parse_fail'); out = out.replace(m[0], soft); continue; }

      const r0 = catalog.find((c) => c.sku.toLowerCase() === parsed.sku.toLowerCase());
      let resolved: { sku: string; sell_price: number; disc: number | null; in_stock: boolean } | null = r0
        ? { sku: r0.sku, sell_price: r0.sell_price, disc: r0.discount_percentage, in_stock: r0.in_stock }
        : null;
      if (!resolved) {
        const fp = (await loadStorefrontProductsBySku([parsed.sku]))[0];
        if (fp) resolved = { sku: fp.sku, sell_price: fp.sell_price, disc: fp.discount_percentage, in_stock: fp.in_stock };
      }
      if (!resolved || !resolved.in_stock) { failed++; details.push(`pm unknown_or_oos:${parsed.sku}`); out = out.replace(m[0], soft); continue; }

      const disc = Math.max(0, Math.min(50, resolved.disc ?? 0));
      const ourPrice = Math.round((disc > 0 ? resolved.sell_price * (1 - disc / 100) : resolved.sell_price) * 100) / 100;
      const floor = priceMatchFloor(costs[resolved.sku.toLowerCase()] ?? null);
      const comp = parsed.competitor;

      let outcome: 'already_cheaper' | 'match' | 'hold';
      let overrideUnitPrice: number | undefined;
      if (comp >= ourPrice - 0.01) outcome = 'already_cheaper';
      else if (floor != null && comp >= floor) { outcome = 'match'; overrideUnitPrice = comp; }
      else outcome = 'hold';

      const r = await buildPayLink(
        [{ sku: resolved.sku, qty: 1, overrideUnitPrice }],
        null, parsed.isFlorida, waPhone, lang,
      );
      if (!r.ok || !r.url) { failed++; details.push(`pm fail ${r.error}`); out = out.replace(m[0], soft); continue; }

      built++;
      details.push(`pm ${outcome} our=${ourPrice} comp=${comp} floor=${floor ?? 'n/a'}`);
      replacement = framePriceMatch(lang, outcome, ourPrice, overrideUnitPrice ?? ourPrice, r.url);
    } catch (e) {
      failed++;
      details.push(`pm err ${e instanceof Error ? e.message : String(e)}`);
    }
    out = out.replace(m[0], replacement);
  }

  return { text: out, built, failed, details };
}

// ── Record the sale as an order ─────────────────────────────────────────────

/**
 * Post-purchase thank-you from Sol — warm, human, brief: gratitude + reassurance
 * we're shipping fast + a promise to follow up with tracking. NO delivery-date
 * promises by design (we sell the speed and "I'm here for you", never a date we
 * might miss). Keep this short — too much detail kills the moment.
 */
function thankYouMessage(lang: 'es' | 'en', firstName: string, orderNumber: string): string {
  const hi = firstName ? `, ${firstName}` : '';
  const ref = orderNumber ? ` *${orderNumber}*` : '';
  if (lang === 'en') {
    return (
      `Thank you for your order${hi}! 🙌\n\n` +
      `Your order${ref} is confirmed and we're already getting it ready to ship as fast as possible. ` +
      `I'll message you right here the moment it's on its way — with your tracking number. ` +
      `Anything you need in the meantime, I'm here for you. — Sol at Oiikon ☀️`
    );
  }
  return (
    `¡Gracias por su compra${hi}! 🙌\n\n` +
    `Su pedido${ref} ya está confirmado y lo estamos preparando para enviárselo lo antes posible. ` +
    `Le aviso por aquí en cuanto vaya en camino — con su número de rastreo. ` +
    `Cualquier cosa que necesite, aquí estoy para ayudarle. — Sol de Oiikon ☀️`
  );
}

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

    // CHOKEPOINT GUARD (defense in depth with the webhook/return checks):
    // never record an order we didn't create. The tag comes from PayPal's own
    // API response — not from any caller-supplied payload — so it can't be
    // forged by whoever invoked this path.
    if (!(details.customId ?? '').startsWith(PAYLINK_TAG)) {
      return { ok: false, error: 'not_paylink_order' };
    }

    // Link the order back to the WhatsApp chat it came from. Sol stamps the
    // buyer's number (wa=) and language (lang=) into the PayPal custom_id when it
    // builds the pay-link, so we recover them here even though PayPal itself
    // rarely returns a phone. This is what lets EVERY order match a WA client.
    const cid = details.customId ?? '';
    const waPhone = cid.match(/wa=(\+?\d{6,15})/)?.[1] ?? null;
    const waLang: 'es' | 'en' = /lang=en/i.test(cid) ? 'en' : 'es';

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

    const shippingCost = Math.round(Number(details.shippingTotal || 0) * 100) / 100;
    const tax = Math.round(Number(details.taxTotal || 0) * 100) / 100;
    const grand = Number(details.grandTotal || capture.amount || 0);
    // subtotal = pre-tax item total (NOT capture.amount, which includes tax+shipping).
    const subtotal = Math.round(Math.max(0, details.itemTotal || grand - shippingCost - tax) * 100) / 100;
    const total = Math.round((subtotal + shippingCost + tax) * 100) / 100; // satisfies validate_order_total

    const { data: inserted, error } = await sb
      .from('orders')
      .upsert({
        // order_number auto-generated by the set_order_number trigger
        customer_email: details.payerEmail ?? 'sin-email@oiikon.com',
        customer_name: details.payerName ?? 'Cliente WhatsApp',
        customer_phone: waPhone ?? details.payerPhone ?? null,
        shipping_address: shippingAddress,
        items,
        subtotal,
        shipping_cost: shippingCost,
        tax,
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
      }, { onConflict: 'paypal_order_id', ignoreDuplicates: true })
      .select('order_number')
      .maybeSingle();

    if (error) return { ok: false, error: error.message };

    // ignoreDuplicates → no row returned means a CONCURRENT insert (the return
    // path vs the webhook fire near-simultaneously) already created this order.
    // Treat as already-existed and do NOT send a second thank-you. This plus the
    // unique index on orders.paypal_order_id makes the insert atomic — one
    // payment can never create two order rows (double fulfillment / stock).
    if (!inserted) {
      const { data: existing2 } = await sb
        .from('orders')
        .select('order_number')
        .eq('paypal_order_id', paypalOrderId)
        .limit(1)
        .maybeSingle();
      return {
        ok: true,
        alreadyExisted: true,
        orderNumber: (existing2 as { order_number?: string } | null)?.order_number,
      };
    }

    const orderNumber = (inserted as { order_number?: string } | null)?.order_number;

    // Sol says thanks — like a human seller would. Runs ONLY here, on a brand-new
    // insert (the idempotent `existing` check above returns earlier), so the
    // return-path + webhook race can't double-send. Fire-and-forget: a failed
    // send can NEVER block or undo the order.
    if (waPhone) {
      try {
        const firstName = (details.payerName ?? '').trim().split(/\s+/)[0] ?? '';
        const thanks = thankYouMessage(waLang, firstName, orderNumber ?? '');
        await sendWhatsAppMessage(waPhone, thanks);
        // Persist it so the dashboard transcript shows the thank-you and the
        // follow-up crons see the conversation's true last message (an
        // unpersisted send made the customer look "silent after quote").
        try {
          const conv = await getOrCreateConversation(waPhone);
          await storeMessage(conv.id, 'assistant', thanks);
        } catch (persistErr) {
          console.warn('[PAYLINK] thank-you persist failed (non-blocking):', persistErr);
        }
      } catch (e) {
        console.error('[PAYLINK] thank-you send failed (non-blocking):', e);
      }
    }

    // Attribution: a captured pay-link payment is GROUND TRUTH that this
    // WhatsApp conversation converted — a real PayPal capture, NOT model
    // inference, so it's a legitimate auto-win (distinct from the Claude path
    // markConversationWon's doc warns against). Until now only the operator's
    // manual /won stamped converted_at, so almost no sales were attributed and
    // /dashboard/ads + the overview CR were effectively blind (1 of ~19 linked).
    // Best-effort: an attribution miss must NEVER block or undo a captured order.
    if (waPhone) {
      try {
        const conv = await getConversationByPhone(waPhone);
        if (conv && !conv.converted_at) await markConversationWon(conv.id);
      } catch (attrErr) {
        console.error(
          '[PAYLINK] conversion attribution failed (non-blocking):',
          attrErr instanceof Error ? attrErr.message : attrErr,
        );
      }
    }

    return { ok: true, orderNumber, shippingIncomplete };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
