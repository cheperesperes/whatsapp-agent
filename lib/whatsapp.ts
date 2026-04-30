// ============================================================
// WhatsApp helpers (Meta Cloud API only)
// ============================================================
// All outbound traffic goes through Meta WhatsApp Cloud API. The
// Twilio path was removed — see lib/whatsapp-meta.ts for the
// underlying Graph API calls. Public function signatures here are
// kept stable so older callers (dashboard send/action routes,
// webhook command handlers) don't need to change.

import {
  sendMetaWhatsAppMessage,
  sendMetaWhatsAppImage,
  parseMetaIncomingMessage,
  isMetaWebhookPayload,
} from './whatsapp-meta';

export type MessageChannel = 'whatsapp';
export type MessageProvider = 'meta';

function metaCreds(): { accessToken: string; phoneNumberId: string } {
  const accessToken =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  if (!accessToken || !phoneNumberId) {
    throw new Error(
      'Missing Meta WhatsApp env vars (META_WHATSAPP_ACCESS_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID)',
    );
  }
  return { accessToken, phoneNumberId };
}

function bareNumber(phone: string): string {
  return phone.startsWith('whatsapp:') ? phone.slice('whatsapp:'.length) : phone;
}

export async function sendMessage(
  to: string,
  body: string,
  _channel: MessageChannel = 'whatsapp',
  fromPhoneNumberId?: string,
): Promise<void> {
  const { accessToken, phoneNumberId } = metaCreds();
  const senderId = fromPhoneNumberId ?? phoneNumberId;
  await sendMetaWhatsAppMessage(bareNumber(to), body, senderId, accessToken);
}

export async function sendWhatsAppMessage(
  to: string,
  body: string,
  fromPhoneNumberId?: string,
): Promise<void> {
  return sendMessage(to, body, 'whatsapp', fromPhoneNumberId);
}

export async function sendImage(
  to: string,
  mediaUrl: string,
  caption?: string,
  _channel: MessageChannel = 'whatsapp',
  fromPhoneNumberId?: string,
): Promise<void> {
  const { accessToken, phoneNumberId } = metaCreds();
  const senderId = fromPhoneNumberId ?? phoneNumberId;
  await sendMetaWhatsAppImage(bareNumber(to), mediaUrl, caption, senderId, accessToken);
}

export async function sendHandoffAlert(
  operatorPhone: string,
  customerPhone: string,
  reason: string,
  lastCustomerMessage: string,
): Promise<void> {
  const alert = [
    '🚨 HANDOFF',
    `De: ${customerPhone}`,
    `Razón: ${reason}`,
    `Último mensaje: "${lastCustomerMessage}"`,
    '',
    `Responder "/bot ${customerPhone}" para devolver al AI.`,
  ].join('\n');

  await sendWhatsAppMessage(operatorPhone, alert);
}

export async function sendEscalatedMessageAlert(
  operatorPhone: string,
  customerPhone: string,
  message: string,
): Promise<void> {
  const alert = `💬 Mensaje de cliente escalado (${customerPhone}):\n"${message}"`;
  await sendWhatsAppMessage(operatorPhone, alert);
}

export interface ParsedIncomingMessage {
  senderPhone: string;
  senderName: string | null;
  messageText: string;
  messageType: string;
  messageId: string;
  timestamp: number;
  channel: MessageChannel;
  provider: MessageProvider;
  /** Meta phone-number ID that received this message — used to route the reply through the same sender. */
  metaRecipientPhoneNumberId: string;
}

export function parseIncomingMessage(body: unknown): ParsedIncomingMessage | null {
  if (!isMetaWebhookPayload(body)) return null;
  const meta = parseMetaIncomingMessage(body);
  if (!meta) return null;
  return {
    senderPhone: meta.senderPhone,
    senderName: meta.senderName,
    messageText: meta.messageText,
    messageType: meta.messageType,
    messageId: meta.messageId,
    timestamp: meta.timestamp,
    channel: 'whatsapp',
    provider: 'meta',
    metaRecipientPhoneNumberId: meta.recipientPhoneNumberId,
  };
}

export async function sendReplyForParsed(
  parsed: ParsedIncomingMessage,
  body: string,
): Promise<void> {
  const { accessToken } = metaCreds();
  await sendMetaWhatsAppMessage(
    parsed.senderPhone,
    body,
    parsed.metaRecipientPhoneNumberId,
    accessToken,
  );
}

export async function sendImageForParsed(
  parsed: ParsedIncomingMessage,
  to: string,
  mediaUrl: string,
  caption?: string,
): Promise<void> {
  const { accessToken } = metaCreds();
  await sendMetaWhatsAppImage(
    bareNumber(to),
    mediaUrl,
    caption,
    parsed.metaRecipientPhoneNumberId,
    accessToken,
  );
}

export function parseOwnerCommand(
  text: string,
): { command: string; args: string } | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('/status')) {
    return { command: 'status', args: '' };
  }

  const botMatch = trimmed.match(/^\/bot\s+(\+?\d+)$/i);
  if (botMatch) {
    return { command: 'bot', args: botMatch[1] };
  }

  const teachMatch = trimmed.match(/^\/teach\s+([\s\S]+)$/i);
  if (teachMatch) {
    return { command: 'teach', args: teachMatch[1].trim() };
  }

  const broadcastMatch = trimmed.match(/^\/broadcast\s+([\s\S]+)$/i);
  if (broadcastMatch) {
    return { command: 'broadcast', args: broadcastMatch[1].trim() };
  }

  const wonMatch = trimmed.match(/^\/won\s+([+\d][\d\s\-().]{5,})$/i);
  if (wonMatch) {
    return { command: 'won', args: wonMatch[1].trim() };
  }

  return null;
}
