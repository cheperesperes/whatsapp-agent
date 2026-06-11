/**
 * Email sending + the web-lead follow-up email template.
 *
 * Transport: Resend REST API, key from process.env.RESEND_API_KEY (Vercel).
 * The key is NOT set by default — sendEmail() reports `configured:false` and
 * the caller treats the run as a dry-run. This keeps going-live a deliberate
 * operator action (paste the key + flip WEB_LEAD_EMAIL_ENABLED=true).
 *
 * Sender identity: "Oiikon <info@oiikon.com>" — the brand's standing sender.
 *
 * CAN-SPAM notes baked into the template:
 *  - Sent ONLY to addresses captured with an explicit unchecked-by-default
 *    consent checkbox in the chat widget (consent text stored verbatim).
 *  - One-click unsubscribe link in every email (+ List-Unsubscribe header).
 *  - Identifies the sender; physical postal address comes from the
 *    BUSINESS_POSTAL_ADDRESS env (falls back to the online-store identity
 *    line until Ed sets it).
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = 'Oiikon <info@oiikon.com>';
const WHATSAPP_LINK = 'https://wa.me/15616988477'; // Sol customer line — NEVER the operator line

export interface SendEmailResult {
  ok: boolean;
  configured: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  unsubscribeUrl?: string;
}): Promise<SendEmailResult> {
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  if (!key) return { ok: false, configured: false, error: 'RESEND_API_KEY not set' };

  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers: args.unsubscribeUrl
          ? { 'List-Unsubscribe': `<${args.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
          : undefined,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!resp.ok) {
      return { ok: false, configured: true, error: data.message ?? `resend http ${resp.status}` };
    }
    return { ok: true, configured: true, id: data.id };
  } catch (err) {
    return { ok: false, configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Follow-up email template ────────────────────────────────────────────────

export interface FollowupEmailInput {
  language: 'es' | 'en';
  productName: string | null;
  productPrice: number | null;
  productUrl: string | null;
  couponCode: string | null;
  couponSavings: number | null;
  unsubscribeUrl: string;
}

export function buildWebLeadFollowupEmail(input: FollowupEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const es = input.language !== 'en';
  const postal = (process.env.BUSINESS_POSTAL_ADDRESS ?? '').trim();

  const productLine = input.productName
    ? es
      ? `Estuvo viendo el <strong>${escapeHtml(input.productName)}</strong>${input.productPrice ? ` — $${input.productPrice.toFixed(2)} con envío gratis en los 48 estados de EE.UU.` : ''}.`
      : `You were looking at the <strong>${escapeHtml(input.productName)}</strong>${input.productPrice ? ` — $${input.productPrice.toFixed(2)} with free shipping in the 48 contiguous states.` : ''}.`
    : es
      ? 'Quedó pendiente su consulta sobre nuestras estaciones de energía.'
      : 'Your question about our power stations is still open.';

  const couponBlock =
    input.couponCode && input.couponSavings
      ? es
        ? `<p style="margin:16px 0;padding:12px 16px;background:#FFF7ED;border:1px solid #F97316;border-radius:8px;">🎁 Use el código <strong>${escapeHtml(input.couponCode)}</strong> y ahorre <strong>$${input.couponSavings.toFixed(2)}</strong> en su pedido.</p>`
        : `<p style="margin:16px 0;padding:12px 16px;background:#FFF7ED;border:1px solid #F97316;border-radius:8px;">🎁 Use code <strong>${escapeHtml(input.couponCode)}</strong> to save <strong>$${input.couponSavings.toFixed(2)}</strong> on your order.</p>`
      : '';

  const cta = input.productUrl
    ? `<p style="margin:20px 0;"><a href="${escapeHtml(input.productUrl)}" style="background:#F97316;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block;">${es ? 'Ver el producto' : 'View the product'}</a></p>`
    : '';

  const subject = es ? 'Se quedó algo pendiente en Oiikon 🔋' : 'You left something behind at Oiikon 🔋';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#020817;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:12px;padding:28px;">
      <h2 style="margin:0 0 12px;color:#020817;">${es ? '¡Hola! Soy Sol, de Oiikon' : "Hi! It's Sol from Oiikon"} 👋</h2>
      <p style="margin:0 0 8px;line-height:1.5;">${productLine}</p>
      <p style="margin:8px 0;line-height:1.5;">${
        es
          ? '¿Le quedó alguna duda? Respondo al momento — y si ya se decidió, le dejo el pedido listo en 2 minutos.'
          : 'Any questions holding you back? I answer right away — and if you’re ready, I’ll have your order set up in 2 minutes.'
      }</p>
      ${couponBlock}
      ${cta}
      <p style="margin:16px 0 0;line-height:1.5;">${
        es
          ? `¿Prefiere chatear? Escríbanos por WhatsApp: <a href="${WHATSAPP_LINK}" style="color:#F97316;">wa.me/15616988477</a> o responda a este correo.`
          : `Prefer to chat? Message us on WhatsApp: <a href="${WHATSAPP_LINK}" style="color:#F97316;">wa.me/15616988477</a> or just reply to this email.`
      }</p>
    </div>
    <p style="font-size:12px;color:#6b7280;margin:16px 8px;line-height:1.6;">
      ${es ? 'Recibió este correo porque lo solicitó en el chat de oiikon.com.' : 'You received this email because you requested it in the chat on oiikon.com.'}
      <br/>Oiikon · <a href="https://oiikon.com" style="color:#6b7280;">oiikon.com</a> · info@oiikon.com${postal ? ` · ${escapeHtml(postal)}` : ''}
      <br/><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280;">${es ? 'Darse de baja' : 'Unsubscribe'}</a>
    </p>
  </div>
</body></html>`;

  const text = es
    ? `¡Hola! Soy Sol, de Oiikon.\n\n${input.productName ? `Estuvo viendo el ${input.productName}${input.productPrice ? ` — $${input.productPrice.toFixed(2)} con envío gratis en EE.UU.` : ''}.` : 'Quedó pendiente su consulta.'}\n¿Le quedó alguna duda? Respondo al momento.\n${input.couponCode && input.couponSavings ? `\nCódigo ${input.couponCode}: ahorre $${input.couponSavings.toFixed(2)}.\n` : ''}${input.productUrl ? `\nVer el producto: ${input.productUrl}\n` : ''}\nWhatsApp: ${WHATSAPP_LINK}\n\nDarse de baja: ${input.unsubscribeUrl}`
    : `Hi! It's Sol from Oiikon.\n\n${input.productName ? `You were looking at the ${input.productName}${input.productPrice ? ` — $${input.productPrice.toFixed(2)} with free US shipping.` : ''}.` : 'Your question is still open.'}\nAny questions holding you back? I answer right away.\n${input.couponCode && input.couponSavings ? `\nCode ${input.couponCode}: save $${input.couponSavings.toFixed(2)}.\n` : ''}${input.productUrl ? `\nView the product: ${input.productUrl}\n` : ''}\nWhatsApp: ${WHATSAPP_LINK}\n\nUnsubscribe: ${input.unsubscribeUrl}`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
