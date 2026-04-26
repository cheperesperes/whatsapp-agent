// ============================================================
// WhatsApp / Twilio API helpers
// ============================================================
// Twilio is the original provider for the Oiikon WhatsApp number
// (+14848644191). Meta WhatsApp Cloud API was added later (file:
// lib/whatsapp-meta.ts) for a second sender that needs to serve markets
// Twilio doesn't support. Inbound payload shape determines provider:
// form-urlencoded → Twilio, JSON `whatsapp_business_account` → Meta.

import {
  sendMetaWhatsAppMessage,
  sendMetaWhatsAppImage,
  parseMetaIncomingMessage,
  isMetaWebhookPayload,
} from './whatsapp-meta';

export type MessageChannel = 'whatsapp' | 'sms';
export type MessageProvider = 'twilio' | 'meta';

/**
 * Send a text message via Twilio. Defaults to WhatsApp for backward compat;
 * callers that know the inbound channel should pass `channel`.
 *
 * `from` lets the caller pin a specific sender — used by the webhook so a
 * reply leaves from the same business number the customer messaged
 * (multi-number support). Falls back to TWILIO_WHATSAPP_NUMBER.
 *
 * For SMS we prefer TWILIO_MESSAGING_SERVICE_SID if set (lets Twilio pick the
 * right sender), falling back to the bare TWILIO_WHATSAPP_NUMBER as a plain
 * From number.
 */
export async function sendMessage(
  to: string,
  body: string,
  channel: MessageChannel = 'whatsapp',
  from?: string
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !twilioWhatsAppNumber) {
    throw new Error('Missing Twilio environment variables');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  // ── Build To / From depending on channel ─────────────────────
  const bareTo = to.startsWith('whatsapp:') ? to.slice('whatsapp:'.length) : to;
  const fromRaw = from ?? twilioWhatsAppNumber;
  const bareFrom = fromRaw.startsWith('whatsapp:')
    ? fromRaw.slice('whatsapp:'.length)
    : fromRaw;

  const params = new URLSearchParams({ Body: body });

  if (channel === 'sms') {
    params.set('To', bareTo);
    if (messagingServiceSid) {
      params.set('MessagingServiceSid', messagingServiceSid);
    } else {
      params.set('From', bareFrom);
    }
  } else {
    params.set('To', `whatsapp:${bareTo}`);
    params.set('From', `whatsapp:${bareFrom}`);
  }

  // Create basic auth header
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Twilio API error ${response.status} (${channel}): ${err}`);
  }
}

/**
 * Back-compat wrapper. Existing code calls sendWhatsAppMessage(to, body) —
 * keep it sending via WhatsApp.
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  from?: string
): Promise<void> {
  return sendMessage(to, body, 'whatsapp', from);
}

/**
 * Send a media message (image/video/pdf) via Twilio. Caption is optional.
 * Twilio fetches `mediaUrl` server-side, so it must be a public HTTPS URL.
 * SMS channel is rejected — MMS pricing differs and this product uses WA only.
 */
export async function sendImage(
  to: string,
  mediaUrl: string,
  caption?: string,
  channel: MessageChannel = 'whatsapp',
  from?: string
): Promise<void> {
  if (channel !== 'whatsapp') {
    throw new Error('sendImage only supports the whatsapp channel');
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!accountSid || !authToken || !twilioWhatsAppNumber) {
    throw new Error('Missing Twilio environment variables');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const bareTo = to.startsWith('whatsapp:') ? to.slice('whatsapp:'.length) : to;
  const fromRaw = from ?? twilioWhatsAppNumber;
  const bareFrom = fromRaw.startsWith('whatsapp:')
    ? fromRaw.slice('whatsapp:'.length)
    : fromRaw;

  const params = new URLSearchParams();
  if (caption && caption.trim()) params.set('Body', caption.trim());
  params.set('MediaUrl', mediaUrl);
  params.set('To', `whatsapp:${bareTo}`);
  params.set('From', `whatsapp:${bareFrom}`);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Twilio media API error ${response.status}: ${err}`);
  }
}

/**
 * Format and send the HANDOFF alert to the operator.
 */
export async function sendHandoffAlert(
  operatorPhone: string,
  customerPhone: string,
  reason: string,
  lastCustomerMessage: string
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

/**
 * Notify operator that a new escalated message arrived while in human mode.
 */
export async function sendEscalatedMessageAlert(
  operatorPhone: string,
  customerPhone: string,
  message: string
): Promise<void> {
  const alert = `💬 Mensaje de cliente escalado (${customerPhone}):\n"${message}"`;
  await sendWhatsAppMessage(operatorPhone, alert);
}

/**
 * Extract text and sender info from an incoming Twilio webhook payload.
 * Twilio sends form-urlencoded data with fields like:
 * - From: "whatsapp:+1234567890"
 * - To: "whatsapp:+16175551234" (our business number)
 * - Body: message text
 * - MessageSid: unique ID
 * - ProfileName: sender's name
 * - etc.
 * Returns null if the message is not a text message we should handle.
 */
export interface ParsedIncomingMessage {
  senderPhone: string;
  senderName: string | null;
  messageText: string;
  messageType: string;
  messageId: string;
  timestamp: number;
  /** Channel the inbound arrived on — used to route the reply. */
  channel: MessageChannel;
  /** Which provider delivered this inbound — controls the outbound API used for the reply. */
  provider: MessageProvider;
  /**
   * Twilio only. The business number that received this message (Twilio `To`
   * field, with `whatsapp:` prefix preserved for WA). Used as the reply's
   * `From` so multi-Twilio-number setups reply from the right sender.
   */
  recipientPhone: string | null;
  /**
   * Meta only. The Meta phone-number ID that received this message — used in
   * the outbound Graph API path so the reply goes through the same sender.
   */
  metaRecipientPhoneNumberId?: string;
}

export function parseIncomingMessage(body: unknown): ParsedIncomingMessage | null {
  // ── Meta JSON payload (whatsapp_business_account) ─────────
  if (isMetaWebhookPayload(body)) {
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
      recipientPhone: null,
      metaRecipientPhoneNumberId: meta.recipientPhoneNumberId,
    };
  }

  // ── Twilio form-encoded payload ───────────────────────────
  try {
    const payload = body as Record<string, string | undefined>;

    // Extract Twilio webhook fields
    const from = payload.From; // "whatsapp:+1234567890" for WA, "+1234567890" for SMS
    const to = payload.To ?? null; // "whatsapp:+1234567890" — our business number
    const messageText = payload.Body ?? '';
    const messageSid = payload.MessageSid ?? '';
    const profileName = payload.ProfileName ?? null;

    if (!from || !messageText.trim()) return null;

    const isWhatsApp = from.startsWith('whatsapp:');
    const senderPhone = isWhatsApp ? from.substring('whatsapp:'.length) : from;

    return {
      senderPhone,
      senderName: profileName,
      messageText,
      messageType: 'text', // Twilio form-data indicates this is text (media would have NumMedia > 0)
      messageId: messageSid,
      timestamp: Math.floor(Date.now() / 1000), // Twilio doesn't include timestamp, use current time
      channel: isWhatsApp ? 'whatsapp' : 'sms',
      provider: 'twilio',
      recipientPhone: to,
    };
  } catch {
    return null;
  }
}

// ── Unified outbound (provider-aware) ─────────────────────
// Picks the right backend (Meta Graph API vs Twilio REST) based on the
// `parsed` inbound. Used by the webhook handler so each reply is sent
// from the same sender that received the original message.

export async function sendReplyForParsed(
  parsed: ParsedIncomingMessage,
  body: string,
): Promise<void> {
  if (parsed.provider === 'meta') {
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) throw new Error('META_WHATSAPP_ACCESS_TOKEN not set');
    if (!parsed.metaRecipientPhoneNumberId) {
      throw new Error('Meta inbound missing metaRecipientPhoneNumberId');
    }
    await sendMetaWhatsAppMessage(
      parsed.senderPhone,
      body,
      parsed.metaRecipientPhoneNumberId,
      accessToken,
    );
    return;
  }
  // Twilio — preserve existing per-sender routing via `from`.
  await sendMessage(
    parsed.senderPhone,
    body,
    parsed.channel,
    parsed.recipientPhone ?? undefined,
  );
}

export async function sendImageForParsed(
  parsed: ParsedIncomingMessage,
  to: string,
  mediaUrl: string,
  caption?: string,
): Promise<void> {
  if (parsed.provider === 'meta') {
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) throw new Error('META_WHATSAPP_ACCESS_TOKEN not set');
    if (!parsed.metaRecipientPhoneNumberId) {
      throw new Error('Meta inbound missing metaRecipientPhoneNumberId');
    }
    await sendMetaWhatsAppImage(
      to,
      mediaUrl,
      caption,
      parsed.metaRecipientPhoneNumberId,
      accessToken,
    );
    return;
  }
  // Twilio — image only supported on the whatsapp channel.
  await sendImage(to, mediaUrl, caption, 'whatsapp', parsed.recipientPhone ?? undefined);
}

/**
 * Detect owner commands from the operator phone.
 * Returns { command, args } or null.
 */
export function parseOwnerCommand(
  text: string
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

  // /won <phone> — operator confirms a conversation closed as a sale.
  // Accepts the phone in any readable form (with or without +, spaces,
  // hyphens). getConversationByAnyPhone normalizes on the way in.
  const wonMatch = trimmed.match(/^\/won\s+([+\d][\d\s\-().]{5,})$/i);
  if (wonMatch) {
    return { command: 'won', args: wonMatch[1].trim() };
  }

  return null;
}
