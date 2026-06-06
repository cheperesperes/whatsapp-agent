/**
 * PayPal webhook — collects the money after a buyer approves a pay-link.
 *
 * Orders are created with intent=CAPTURE; approval alone does NOT collect funds,
 * so on CHECKOUT.ORDER.APPROVED we call capture. PAYMENT.CAPTURE.COMPLETED then
 * confirms the money landed and we ping the operator ("💰 sale closed").
 *
 * This path is public (middleware allowlist) so PayPal can reach it; authenticity
 * is enforced by verifying PayPal's signature against PAYPAL_WEBHOOK_ID.
 *
 * SETUP — PayPal Developer Dashboard (LIVE app) → Webhooks:
 *   URL:    https://<prod-domain>/api/paypal/webhook
 *   Events: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED
 * Then add PAYPAL_WEBHOOK_ID to Vercel. Until that env is set the endpoint logs
 * a warning and processes UNVERIFIED (so you can smoke-test), so set it promptly.
 */
import { capturePayPalOrder, verifyPayPalWebhook } from '@/lib/marketing/paypal';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

async function pingOperator(text: string): Promise<void> {
  try {
    await sendWhatsAppMessage(OPERATOR_PHONE, text);
  } catch (e) {
    console.error('[PAYPAL-WH] operator ping failed:', e);
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  let verified = false;
  if (webhookId) {
    verified = await verifyPayPalWebhook(
      {
        authAlgo: req.headers.get('paypal-auth-algo'),
        certUrl: req.headers.get('paypal-cert-url'),
        transmissionId: req.headers.get('paypal-transmission-id'),
        transmissionSig: req.headers.get('paypal-transmission-sig'),
        transmissionTime: req.headers.get('paypal-transmission-time'),
      },
      event,
      webhookId,
    );
    if (!verified) {
      console.warn('[PAYPAL-WH] signature verification FAILED — rejecting');
      return new Response('invalid signature', { status: 401 });
    }
  } else {
    console.warn(
      '[PAYPAL-WH] PAYPAL_WEBHOOK_ID not set — processing UNVERIFIED (set it in Vercel to secure this endpoint)',
    );
  }

  const type: string = event?.event_type ?? 'unknown';
  const resource = event?.resource ?? {};
  console.log(`[PAYPAL-WH] ${type} verified=${verified} resourceId=${resource?.id ?? '?'}`);

  try {
    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const orderId: string = resource?.id;
      const cap = await capturePayPalOrder(orderId);
      console.log(
        `[PAYPAL-WH] capture order=${orderId} ok=${cap.ok} status=${cap.status ?? ''} amount=${cap.amount ?? ''} already=${cap.alreadyCaptured ?? false} err=${cap.error ?? ''}`,
      );
      if (!cap.ok) {
        await pingOperator(
          `⚠️ PayPal: orden ${orderId} aprobada pero NO se pudo capturar el pago. Revísala. (${cap.error ?? ''})`,
        );
      }
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      const amount = resource?.amount?.value ?? '?';
      const currency = resource?.amount?.currency_code ?? 'USD';
      const capId = resource?.id ?? '?';
      console.log(`[PAYPAL-WH] CAPTURE.COMPLETED ${capId} ${amount} ${currency}`);
      await pingOperator(`💰 Pago recibido: ${amount} ${currency} (PayPal captura ${capId}). ¡Venta cerrada!`);
    }
  } catch (e) {
    console.error('[PAYPAL-WH] handler error:', e);
  }

  // Always 200 so PayPal doesn't retry-storm on a transient handler hiccup.
  return new Response('ok', { status: 200 });
}
