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
 * Create a PayPal order and return the hosted approval URL.
 * @param shippingFlat optional flat shipping (USD); 0 = free.
 * @param appUrl       site base for return/cancel URLs (e.g. https://oiikon.com)
 */
export async function createPayLink(
  items: PayLinkItem[],
  opts: { shippingFlat?: number; appUrl?: string; note?: string } = {},
): Promise<PayLinkResult> {
  if (!isPayPalConfigured()) return { ok: false, error: 'PayPal not configured (PAYPAL_CLIENT_ID / PAYPAL_SECRET)' };
  if (!items.length) return { ok: false, error: 'no items' };

  const itemTotal = items.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const shipping = Math.max(0, opts.shippingFlat ?? 0);
  const grand = itemTotal + shipping;
  const appUrl = opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com';

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
          },
        },
        items: items.map((it) => ({
          name: it.name.slice(0, 127),
          sku: it.sku?.slice(0, 127),
          quantity: String(it.qty),
          unit_amount: { currency_code: 'USD', value: money(it.unit_price) },
        })),
        ...(opts.note ? { custom_id: opts.note.slice(0, 127) } : {}),
      },
    ],
    application_context: {
      brand_name: 'Oiikon',
      shipping_preference: 'GET_FROM_FILE', // let buyer enter shipping address
      user_action: 'PAY_NOW',
      return_url: `${appUrl}/?paid=1`,
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
