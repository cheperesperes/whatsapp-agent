// ============================================================
// WhatsApp / Twilio API helpers
// ============================================================

export type MessageChannel = 'whatsapp' | 'sms';

/**
 * Send a text message via Twilio. Defaults to WhatsApp for backward compat;
 * callers that know the inbound channel should pass `channel`.
 *
 * For SMS we prefer TWILIO_MESSAGING_SERVICE_SID if set (lets Twilio pick the
 * right sender), falling back to the bare TWILIO_WHATSAPP_NUMBER as a plain
 * From number.
 */
export async function sendMessage(
  to: string,
  body: string,
  channel: MessageChannel = 'whatsapp'
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
  const bareFrom = twilioWhatsAppNumber.startsWith('whatsapp:')
    ? twilioWhatsAppNumber.slice('whatsapp:'.length)
    : twilioWhatsAppNumber;

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
export async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  return sendMessage(to, body, 'whatsapp');
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
  channel: MessageChannel = 'whatsapp'
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
  const bareFrom = twilioWhatsAppNumber.startsWith('whatsapp:')
    ? twilioWhatsAppNumber.slice('whatsapp:'.length)
    : twilioWhatsAppNumber;

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
}

export function parseIncomingMessage(body: unknown): ParsedIncomingMessage | null {
  try {
    const payload = body as Record<string, string | undefined>;

    // Extract Twilio webhook fields
    const from = payload.From; // "whatsapp:+1234567890" for WA, "+1234567890" for SMS
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
    };
  } catch {
    return null;
  }
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
