/**
 * Order-update notifications from Sol (WhatsApp) — "your order shipped + tracking".
 *
 * Reuses the WhatsApp number now stamped on every pay-link order (#144) so we can
 * message a customer about THEIR specific order. Powers the operator "Notify
 * customer" action (POST /api/orders/notify) and, later, an auto shipped-DM cron.
 *
 * WhatsApp policy: free-form text only works inside the 24h customer-service
 * window. A shipped update usually fires days later → outside the window → it then
 * needs an approved Meta TEMPLATE (env ORDER_UPDATE_TEMPLATE). Within 24h we send
 * free-form; outside 24h with no template configured we report it (never throw).
 *
 * Voice rules (see memory): NO delivery-date promises — sell speed + "I'm here for
 * you". A tracking number IS appropriate to share on a shipped update.
 *
 * Self-contained on purpose: talks to the low-level Meta template sender directly
 * (rather than a lib/whatsapp wrapper) so this file adds no coupling to in-flight
 * work elsewhere.
 */
import {
  createServiceClient,
  getConversationByPhone,
  storeMessage,
  loadCustomerProfile,
} from './supabase';
import { sendWhatsAppMessage } from './whatsapp';
import { sendMetaWhatsAppTemplate } from './whatsapp-meta';

export type OrderNotifyType = 'shipped' | 'thanks' | 'custom';

export interface OrderNotifyResult {
  ok: boolean;
  orderNumber?: string;
  sent?: boolean;
  channel?: 'freeform' | 'template';
  skipped?: string;
  error?: string;
}

interface OrderRow {
  id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipping_carrier: string | null;
}

const sentinel = (type: OrderNotifyType, ref: string) => `[NOTIFY:${type}:${ref}]`;

function firstNameOf(full: string | null, lang: 'es' | 'en'): string {
  const token = (full ?? '').trim().split(/\s+/)[0];
  return token || (lang === 'en' ? '' : '');
}

function shippedBody(lang: 'es' | 'en', name: string, o: OrderRow): string {
  const hi = name ? `, ${name}` : '';
  const ref = o.order_number ? ` *${o.order_number}*` : '';
  const carrier = o.shipping_carrier ? `${o.shipping_carrier} ` : '';
  if (lang === 'en') {
    const track = o.tracking_number ? `\n🚚 ${carrier}Tracking: *${o.tracking_number}*` : '';
    const url = o.tracking_url ? `\n👉 ${o.tracking_url}` : '';
    return (
      `Great news${hi}! 📦 Your order${ref} is on its way — fast and secure.${track}${url}` +
      `\n\nAnything you need, I'm here for you. 🙌 — Sol at Oiikon`
    );
  }
  const track = o.tracking_number ? `\n🚚 ${carrier}Rastreo: *${o.tracking_number}*` : '';
  const url = o.tracking_url ? `\n👉 ${o.tracking_url}` : '';
  return (
    `¡Buenas noticias${hi}! 📦 Su pedido${ref} ya va en camino — rápido y seguro.${track}${url}` +
    `\n\nCualquier cosa que necesite, aquí estoy para ayudarle. 🙌 — Sol de Oiikon`
  );
}

function thanksBody(lang: 'es' | 'en', name: string, orderNumber: string): string {
  const hi = name ? `, ${name}` : '';
  const ref = orderNumber ? ` *${orderNumber}*` : '';
  if (lang === 'en') {
    return (
      `Thank you for your order${hi}! 🙌 Your order${ref} is confirmed and we're getting it ` +
      `ready to ship as fast as possible. I'll message you here with tracking the moment it's on ` +
      `its way. — Sol at Oiikon`
    );
  }
  return (
    `¡Gracias por su compra${hi}! 🙌 Su pedido${ref} ya está confirmado y lo estamos preparando ` +
    `para enviárselo lo antes posible. Le aviso por aquí con su rastreo en cuanto vaya en camino. ` +
    `— Sol de Oiikon`
  );
}

/** True if the customer messaged us within the last 24h (Meta free-form window open). */
async function inboundWithin24h(conversationId: string): Promise<boolean> {
  const sb = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('role', 'user')
    .gte('created_at', since)
    .limit(1);
  return Boolean(data && data.length);
}

/** True if we've already sent this exact notification (sentinel logged in-thread). */
async function alreadyNotified(conversationId: string, type: OrderNotifyType, ref: string): Promise<boolean> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .ilike('content', `%${sentinel(type, ref)}%`)
    .limit(1);
  return Boolean(data && data.length);
}

function metaCreds(): { accessToken: string; phoneNumberId: string } | null {
  const accessToken =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

/**
 * Send a customer an update about their order. Idempotent for 'shipped' (won't
 * re-send unless `force`), best-effort logging, never throws to the caller.
 */
export async function notifyOrder(opts: {
  orderNumber: string;
  type: OrderNotifyType;
  customText?: string;
  force?: boolean; // operator override of the dedupe guard
}): Promise<OrderNotifyResult> {
  const sb = createServiceClient();
  const { data: order } = await sb
    .from('orders')
    .select('id, order_number, customer_name, customer_phone, tracking_number, tracking_url, shipping_carrier')
    .eq('order_number', opts.orderNumber)
    .maybeSingle();
  if (!order) return { ok: false, error: 'order_not_found' };
  const o = order as OrderRow;

  const phone = o.customer_phone;
  if (!phone) return { ok: false, orderNumber: o.order_number ?? undefined, error: 'no_customer_phone' };
  if (opts.type === 'shipped' && !o.tracking_number) {
    return { ok: false, orderNumber: o.order_number ?? undefined, error: 'no_tracking_number' };
  }

  const profile = await loadCustomerProfile(phone);
  const lang: 'es' | 'en' = profile?.language === 'en' ? 'en' : 'es';
  const name = firstNameOf(o.customer_name, lang);

  let body: string;
  if (opts.type === 'shipped') body = shippedBody(lang, name, o);
  else if (opts.type === 'thanks') body = thanksBody(lang, name, o.order_number ?? '');
  else body = (opts.customText ?? '').trim();
  if (!body) return { ok: false, orderNumber: o.order_number ?? undefined, error: 'empty_message' };

  const ref = o.order_number ?? o.id;
  const conv = await getConversationByPhone(phone);

  if (!opts.force && conv && (await alreadyNotified(conv.id, opts.type, ref))) {
    return { ok: true, orderNumber: o.order_number ?? undefined, sent: false, skipped: 'already_notified' };
  }

  const within24h = conv ? await inboundWithin24h(conv.id) : false;
  const templateName = process.env.ORDER_UPDATE_TEMPLATE;
  let channel: 'freeform' | 'template' = 'freeform';
  try {
    if (within24h || !templateName) {
      // Free-form — works inside the 24h window. Outside it, Meta rejects and we
      // surface the error so the caller knows a template is needed.
      await sendWhatsAppMessage(phone, body);
      channel = 'freeform';
    } else {
      // Outside 24h → approved Meta template. Convention: {{1}}=name, {{2}}=tracking
      // (or the update text for non-shipped types). Configure the template to match.
      const creds = metaCreds();
      if (!creds) return { ok: false, orderNumber: o.order_number ?? undefined, error: 'meta_creds_missing' };
      const langCode = lang === 'en' ? 'en_US' : 'es';
      const param2 = opts.type === 'shipped' ? (o.tracking_number ?? '') : body.replace(/\s+/g, ' ').slice(0, 240);
      await sendMetaWhatsAppTemplate(
        phone,
        templateName,
        langCode,
        [name || (lang === 'en' ? 'there' : 'amigo/a'), param2],
        creds.phoneNumberId,
        creds.accessToken,
      );
      channel = 'template';
    }
  } catch (e) {
    return { ok: false, orderNumber: o.order_number ?? undefined, error: e instanceof Error ? e.message : String(e) };
  }

  // Log the outbound in-thread for visibility + dedupe. Best-effort.
  if (conv) {
    try {
      await storeMessage(conv.id, 'assistant', `${sentinel(opts.type, ref)} ${body}`);
    } catch {
      /* non-blocking */
    }
  }

  return { ok: true, orderNumber: o.order_number ?? undefined, sent: true, channel };
}
