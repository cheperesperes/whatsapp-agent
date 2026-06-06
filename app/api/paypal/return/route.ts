/**
 * PayPal RETURN handler — the RELIABLE capture path.
 *
 * After the buyer approves on PayPal's hosted page, PayPal redirects them back
 * to this URL with `?token=<orderId>&PayerID=...`. We CAPTURE the order right
 * here (synchronously), ping the operator, then bounce the buyer to the
 * storefront. This does NOT depend on the async CHECKOUT.ORDER.APPROVED webhook
 * (which proved unreliable). The webhook stays as an idempotent backup.
 *
 * Public (middleware allowlist `/api/paypal/`). Only OUR pay-link orders set
 * their return_url here, so this only ever captures our own orders.
 */
import { capturePayPalOrder } from '@/lib/marketing/paypal';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const STORE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com').replace(/\/+$/, '');

export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token'); // PayPal order id

  if (!token) {
    console.warn('[PAYPAL-RETURN] no token on return — landing buyer without capture');
    return Response.redirect(`${STORE_URL}/?paid=1`, 302);
  }

  const cap = await capturePayPalOrder(token);
  console.log(
    `[PAYPAL-RETURN] order=${token} ok=${cap.ok} status=${cap.status ?? ''} amount=${cap.amount ?? ''} already=${cap.alreadyCaptured ?? false} err=${cap.error ?? ''}`,
  );

  if (cap.ok && !cap.alreadyCaptured) {
    try {
      await sendWhatsAppMessage(
        OPERATOR_PHONE,
        `💰 Pago recibido: ${cap.amount ?? '?'} ${cap.currency ?? 'USD'} (PayPal ${cap.captureId ?? token}). ¡Venta cerrada!`,
      );
    } catch (e) {
      console.error('[PAYPAL-RETURN] operator ping failed:', e);
    }
  }

  const dest = cap.ok ? `${STORE_URL}/?paid=1` : `${STORE_URL}/?pay=error`;
  return Response.redirect(dest, 302);
}
