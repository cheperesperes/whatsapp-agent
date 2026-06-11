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
import { capturePayPalOrder, getPayPalOrder, PAYLINK_TAG } from '@/lib/marketing/paypal';
import { recordPayLinkOrder } from '@/lib/paylink';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const STORE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://oiikon.com').replace(/\/+$/, '');

export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token'); // PayPal order id

  if (!token || !/^[A-Z0-9-]{8,32}$/i.test(token)) {
    console.warn('[PAYPAL-RETURN] missing/malformed token on return — landing buyer without capture');
    return Response.redirect(`${STORE_URL}/?paid=1`, 302);
  }

  // TAMPER GUARD: this endpoint is public and `token` is caller-controlled.
  // Capture ONLY orders WE created (PAYLINK_TAG stamped into custom_id at
  // build time). Without this check, anyone with a valid PayPal order id from
  // the SAME merchant account (e.g. a storefront buyer with their own order)
  // could trigger a premature capture here plus a duplicate WhatsApp order
  // row — i.e. a double shipment. If PayPal is briefly unreachable we skip the
  // capture; the signature-verified webhook remains the idempotent backup.
  const details = await getPayPalOrder(token);
  if (!details.ok || !(details.customId ?? '').startsWith(PAYLINK_TAG)) {
    console.warn(
      `[PAYPAL-RETURN] refusing capture for order ${token}: ` +
        (details.ok ? `not a pay-link order (custom_id="${(details.customId ?? '').slice(0, 40)}")` : `order lookup failed (${details.error ?? '?'})`),
    );
    return Response.redirect(`${STORE_URL}/?pay=error`, 302);
  }

  const cap = await capturePayPalOrder(token);
  console.log(
    `[PAYPAL-RETURN] order=${token} ok=${cap.ok} status=${cap.status ?? ''} amount=${cap.amount ?? ''} already=${cap.alreadyCaptured ?? false} err=${cap.error ?? ''}`,
  );

  if (cap.ok) {
    // Record the sale as an order → fires storefront triggers (admin EMAIL,
    // order number, financials, order SMS). Best-effort + idempotent: never
    // blocks the payment, never duplicates.
    try {
      const rec = await recordPayLinkOrder(token, cap);
      console.log(
        `[PAYPAL-RETURN] order-record ok=${rec.ok} order=${rec.orderNumber ?? ''} existed=${rec.alreadyExisted ?? false} err=${rec.error ?? ''}`,
      );
      if (!rec.ok) {
        try {
          await sendWhatsAppMessage(
            OPERATOR_PHONE,
            `⚠️ Pago capturado (${cap.amount ?? '?'} ${cap.currency ?? 'USD'}) pero NO se creó la orden: ${rec.error ?? ''}. Crearla manual.`,
          );
        } catch { /* best effort */ }
      } else if (rec.shippingIncomplete) {
        try {
          await sendWhatsAppMessage(
            OPERATOR_PHONE,
            `⚠️ Orden ${rec.orderNumber ?? ''} creada, pero la DIRECCIÓN de envío está incompleta. Confírmala con el cliente antes de enviar.`,
          );
        } catch { /* best effort */ }
      }
    } catch (e) {
      console.error('[PAYPAL-RETURN] order-record error:', e);
    }

    // Immediate operator ping (the admin email also fires via the order trigger).
    if (!cap.alreadyCaptured) {
      try {
        await sendWhatsAppMessage(
          OPERATOR_PHONE,
          `💰 Pago recibido: ${cap.amount ?? '?'} ${cap.currency ?? 'USD'} (PayPal ${cap.captureId ?? token}). ¡Venta cerrada!`,
        );
      } catch (e) {
        console.error('[PAYPAL-RETURN] operator ping failed:', e);
      }
    }
  }

  const dest = cap.ok ? `${STORE_URL}/?paid=1` : `${STORE_URL}/?pay=error`;
  return Response.redirect(dest, 302);
}
