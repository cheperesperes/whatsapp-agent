// ============================================================
// Meta WhatsApp Cloud API helpers
// ============================================================
// This file is the Meta-side counterpart of lib/whatsapp.ts (Twilio).
// The two are intentionally kept separate so the existing Twilio path
// stays untouched while we add a parallel Meta path for a second
// business number.

import crypto from 'node:crypto';
import type { WhatsAppWebhookBody, WhatsAppMessage } from './types';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

// ── Outbound: send text ─────────────────────────────────────
export async function sendMetaWhatsAppMessage(
  to: string,
  body: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'text',
    text: { body },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta WA send failed ${res.status}: ${err}`);
  }
}

// ── Outbound: send image ────────────────────────────────────
export async function sendMetaWhatsAppImage(
  to: string,
  mediaUrl: string,
  caption: string | undefined,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`;
  const image: { link: string; caption?: string } = { link: mediaUrl };
  if (caption?.trim()) image.caption = caption.trim();
  const payload = {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    type: 'image',
    image,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta WA image send failed ${res.status}: ${err}`);
  }
}

// ── Inbound: parse webhook payload ──────────────────────────
export interface ParsedMetaIncoming {
  senderPhone: string;
  senderName: string | null;
  messageText: string;
  messageType: string;
  messageId: string;
  timestamp: number;
  /** The Meta phone-number ID that received this message — used to route replies back through the same sender. */
  recipientPhoneNumberId: string;
}

export function parseMetaIncomingMessage(body: unknown): ParsedMetaIncoming | null {
  try {
    const payload = body as WhatsAppWebhookBody;
    if (payload?.object !== 'whatsapp_business_account') return null;
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return null;

    const msg = value.messages[0] as WhatsAppMessage;
    const contact = value.contacts?.[0];
    const profileName = contact?.profile?.name ?? null;
    const senderPhone = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;

    // Extract text from text or interactive messages; other types fall through with empty text
    const messageText =
      msg.type === 'text' ? msg.text?.body ?? '' : '';

    return {
      senderPhone,
      senderName: profileName,
      messageText,
      messageType: msg.type,
      messageId: msg.id,
      timestamp: Number(msg.timestamp),
      recipientPhoneNumberId: value.metadata.phone_number_id,
    };
  } catch {
    return null;
  }
}

// Quick payload-shape detector (vs Twilio form-encoded payloads)
export function isMetaWebhookPayload(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { object?: string }).object === 'whatsapp_business_account'
  );
}

// ── Webhook signature verification ──────────────────────────
// Meta signs POSTs with HMAC-SHA256 of the raw body using the App Secret,
// in the `X-Hub-Signature-256: sha256=<hex>` header.
export function verifyMetaSignature(
  appSecret: string,
  signatureHeader: string | null,
  rawBody: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const computed = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}
