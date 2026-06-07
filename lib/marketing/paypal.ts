/**
 * PayPal hosted pay-link generator (Orders v2).
 *
 * Produces a single tap-to-pay URL for an EXACT total (qty × price + shipping),
 * payable as a GUEST with card / PayPal / Apple Pay — no account. This is the
 * "Facebook-style pay link" for customers whose relative "only knows how to pay
 * by link" (diaspora / older buyers).
 *
 * Setup (add to Vercel):
 *   PAYPAL_CLIENT_ID, PAYPAL_SECRET      — REST app credentials
 *   PAYPAL_ENV = live | sandbox          — default 'live'
 * The hosted approval page is PayPal's own, so guest card checkout + Apple Pay
 * work out of the box; no extra SDK on our side.
 */

const PP_ENV = (process.env.PAYPAL_ENV ?? 'live').toLowerCase();
const PP_BASE = PP_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

/**
 * Marker stamped into every pay-link order's custom_id. The storefront uses the
 * SAME PayPal account, so our webhook also receives ITS order events — it must
 * ONLY act on orders whose custom_id starts with this tag (i.e. orders WE
 * created), and ignore storefront-checkout orders entirely.
 */
export const PAYLINK_TAG = 'WA pay-link';

export interface PayLinkItem {
  name: string;
  sku?: string;
  unit_price: number; // USD
  qty: number;
}

export interface PayLinkResult {
  ok: boolean;
  url?: string;        // hosted approve link to send the customer
  order_id?: string;
  total?: number;
  error?: string;
}

function creds(): { id: string; secret: string } | null {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

export function isPayPalConfigured(): boolean {
  return creds() !== null;
}

async function getAccessToken(): Promise<string> {
  const c = creds();
  if (!c) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_SECRET not set');
  const auth = Buffer.from(`${c.id}:${c.secret}`).toString('base64');
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('PayPal auth: no access_token');
  return data.access_token;
}

const money = (n: number) => n.toFixed(2);

/**
 * Compose the PayPal `custom_id` (max 127 chars). PAYLINK_TAG goes FIRST so the
 * shared-account webhook can tell our pay-link orders from storefront orders. We
 * then carry the originating WhatsApp number (`wa=`) and language (`lang=`) —
 * kept near the front so they survive truncation — so the capture step can link
 * the order back to its chat and let Sol message the buyer. Any note/coupon
 * trails last. With no wa/lang this matches the legacy `WA pay-link · note` form.
 */
function buildPayLinkCustomId(opts: { note?: string; waPhone?: string; lang?: string }): string {
  const parts: string[] = [PAYLINK_TAG];
  if (opts.waPhone) parts.push(`wa=${opts.waPhone}`);
  if (opts.lang) parts.push(`lang=${opts.lang}`);
  const note = opts.note
    ? opts.note.startsWith(PAYLINK_TAG)
      ? opts.note.slice(PAYLINK_TAG.length).replace(/^[\s·]+/, '')
      : opts.note
    : '';
  if (note) parts.push(note);
  return parts.join(' · ').slice(0, 127);
}

/**
 * Create a PayPal order and return the hosted approval URL.
 * @param shippingFlat optional flat shipping (USD); 0 = free.
 * @param appUrl       site base for return/cancel URLs (e.g. https://oiikon.com)
 */
export async function createPayLink(
  items: PayLinkItem[],
  opts: { shippingFlat?: number; appUrl?: string; note?: string; tax?: number; waPhone?: string; lang?: 'es' | 'en' } = {},
): Promise<PayLinkResult> {
  if (!isPayPalConfigured()) return { ok: false, error: 'PayPal not configured (PAYPAL_CLIENT_ID / PAYPAL_SECRET)' };
  if (!items.length) return { ok: false, error: 'no items' };

  const itemTotal = items.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const shipping = Math.max(0, opts.shippingFlat ?? 0);
  const tax = Math.max(0, opts.tax ?? 0);
  const grand = itemTotal + shipping + tax;
  const appUrl = opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com';
  // Our own (agent) base URL. PayPal returns the buyer HERE after approval so we
  // capture the order synchronously (the async webhook proved unreliable), then
  // redirect the buyer on to the storefront. Falls back to the known prod alias.
  const agentBase = (
    process.env.AGENT_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'https://whatsapp-agent-ebon-nine.vercel.app')
  ).replace(/\/+$/, '');

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: 'USD',
          value: money(grand),
          breakdown: {
            item_total: { currency_code: 'USD', value: money(itemTotal) },
            shipping: { currency_code: 'USD', value: money(shipping) },
            ...(tax > 0 ? { tax_total: { currency_code: 'USD', value: money(tax) } } : {}),
          },
        },
        items: items.map((it) => ({
          name: it.name.slice(0, 127),
          sku: it.sku?.slice(0, 127),
          quantity: String(it.qty),
          unit_amount: { currency_code: 'USD', value: money(it.unit_price) },
        })),
        // Stamp PAYLINK_TAG first (webhook isolation) and carry the originating
        // WhatsApp number + language so capture can link the order to the chat.
        custom_id: buildPayLinkCustomId(opts),
      },
    ],
    application_context: {
      brand_name: 'Oiikon',
      // Show the card / guest form first (not the PayPal-login wall) so buyers
      // without a PayPal account can pay by card — the whole point of pay-links
      // for diaspora/older buyers. Requires "PayPal Account Optional" ON in the
      // PayPal account settings; otherwise PayPal falls back to login.
      landing_page: 'BILLING',
      shipping_preference: 'GET_FROM_FILE', // let buyer enter shipping address
      user_action: 'PAY_NOW',
      // Capture-on-return: route the post-approval redirect through our server,
      // which captures the order, then bounces the buyer to the storefront.
      return_url: `${agentBase}/api/paypal/return`,
      cancel_url: `${appUrl}/?cancelled=1`,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    return { ok: false, error: `PayPal create order failed: ${String(e?.message ?? e)}` };
  }
  if (!res.ok) return { ok: false, error: `PayPal create order ${res.status}: ${(await res.text()).slice(0, 200)}` };

  const data = (await res.json()) as { id?: string; links?: Array<{ rel: string; href: string }> };
  const approve = data.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
  if (!data.id || !approve) return { ok: false, error: 'PayPal response missing approve link' };

  return { ok: true, url: approve, order_id: data.id, total: grand };
}

// ── Capture (collect the money after the buyer approves) ───────────────────

export interface CaptureResult {
  ok: boolean;
  status?: string;       // e.g. COMPLETED
  captureId?: string;
  amount?: string;       // e.g. "469.00"
  currency?: string;
  payerEmail?: string;
  alreadyCaptured?: boolean;
  error?: string;
}

/**
 * Capture an APPROVED PayPal order — the step that actually collects the funds.
 * Idempotent: an already-captured order resolves to { ok:true, alreadyCaptured:true }
 * instead of erroring, so the webhook and a return-path can both fire safely.
 */
export async function capturePayPalOrder(orderId: string): Promise<CaptureResult> {
  if (!isPayPalConfigured()) return { ok: false, error: 'PayPal not configured' };
  if (!orderId) return { ok: false, error: 'no order id' };

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  let res: Response;
  try {
    res = await fetch(`${PP_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Idempotency: PayPal won't double-capture for the same request id.
        'PayPal-Request-Id': `cap-${orderId}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    return { ok: false, error: `capture request failed: ${String(e?.message ?? e)}` };
  }

  const text = await res.text();
  // Already captured (e.g. webhook + return path raced) — treat as success.
  if (res.status === 422 && /ORDER_ALREADY_CAPTURED/i.test(text)) {
    return { ok: true, alreadyCaptured: true, status: 'COMPLETED' };
  }
  if (!res.ok) return { ok: false, error: `capture ${res.status}: ${text.slice(0, 200)}` };

  let data: any = {};
  try { data = JSON.parse(text); } catch { /* keep {} */ }
  const cap = data?.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    ok: true,
    status: data?.status ?? cap?.status,
    captureId: cap?.id,
    amount: cap?.amount?.value,
    currency: cap?.amount?.currency_code,
    payerEmail: data?.payer?.email_address,
  };
}

// ── Order details (to record the sale as an order after capture) ───────────

export interface PayPalOrderItem {
  sku?: string;
  name: string;
  quantity: number;
  unitPrice: number;
}
export interface PayPalOrderDetails {
  ok: boolean;
  payerName?: string;
  payerEmail?: string;
  payerPhone?: string;
  shipping?: any; // raw PayPal shipping object { name, address }
  items: PayPalOrderItem[];
  itemTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  currency: string;
  customId?: string;
  error?: string;
}

/**
 * Fetch a PayPal order's details (items, shipping, payer, totals) so we can
 * record a matching `orders` row after capturing. Read-only GET.
 */
export async function getPayPalOrder(orderId: string): Promise<PayPalOrderDetails> {
  const empty = { items: [] as PayPalOrderItem[], itemTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, currency: 'USD' };
  if (!isPayPalConfigured()) return { ok: false, ...empty, error: 'PayPal not configured' };
  if (!orderId) return { ok: false, ...empty, error: 'no order id' };

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e: any) {
    return { ok: false, ...empty, error: String(e?.message ?? e) };
  }

  let res: Response;
  try {
    res = await fetch(`${PP_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    return { ok: false, ...empty, error: `get order failed: ${String(e?.message ?? e)}` };
  }
  if (!res.ok) return { ok: false, ...empty, error: `get order ${res.status}: ${(await res.text()).slice(0, 160)}` };

  const d: any = await res.json();
  const pu = d?.purchase_units?.[0] ?? {};
  const payer = d?.payer ?? {};
  const payerName =
    [payer?.name?.given_name, payer?.name?.surname].filter(Boolean).join(' ') ||
    pu?.shipping?.name?.full_name ||
    undefined;
  const payerPhone =
    payer?.phone?.phone_number?.national_number ||
    pu?.shipping?.phone_number?.national_number ||
    undefined;
  const items: PayPalOrderItem[] = (pu?.items ?? []).map((it: any) => ({
    sku: it?.sku || undefined,
    name: it?.name ?? 'Item',
    quantity: Number(it?.quantity ?? 1) || 1,
    unitPrice: Number(it?.unit_amount?.value ?? 0),
  }));
  const bd = pu?.amount?.breakdown ?? {};
  return {
    ok: true,
    payerName,
    payerEmail: payer?.email_address,
    payerPhone,
    shipping: pu?.shipping ?? null,
    items,
    itemTotal: Number(bd?.item_total?.value ?? pu?.amount?.value ?? 0),
    shippingTotal: Number(bd?.shipping?.value ?? 0),
    taxTotal: Number(bd?.tax_total?.value ?? 0),
    grandTotal: Number(pu?.amount?.value ?? 0),
    currency: pu?.amount?.currency_code ?? 'USD',
    customId: pu?.custom_id,
  };
}

// ── Webhook signature verification ─────────────────────────────────────────

export interface PayPalWebhookHeaders {
  authAlgo?: string | null;
  certUrl?: string | null;
  transmissionId?: string | null;
  transmissionSig?: string | null;
  transmissionTime?: string | null;
}

/**
 * Verify a PayPal webhook event is genuine via PayPal's verify-webhook-signature
 * API. Requires PAYPAL_WEBHOOK_ID (the ID of the webhook registered in PayPal).
 */
export async function verifyPayPalWebhook(
  headers: PayPalWebhookHeaders,
  event: unknown,
  webhookId: string,
): Promise<boolean> {
  if (
    !webhookId ||
    !headers.authAlgo ||
    !headers.certUrl ||
    !headers.transmissionId ||
    !headers.transmissionSig ||
    !headers.transmissionTime
  ) {
    return false;
  }
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return false;
  }
  try {
    const res = await fetch(`${PP_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { verification_status?: string };
    return data.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
