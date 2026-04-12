// ============================================================
// WhatsApp / Meta Cloud API helpers
// ============================================================

const META_API_VERSION = 'v21.0';

/**
 * Send a text message via Meta Cloud API.
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error('Missing WhatsApp environment variables');
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WhatsApp API error ${response.status}: ${err}`);
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
 * Extract text and sender info from an incoming Meta webhook payload.
 * Returns null if the message is not a text message we should handle.
 */
export interface ParsedIncomingMessage {
  senderPhone: string;
  senderName: string | null;
  messageText: string;
  messageType: string;
  messageId: string;
  timestamp: number;
}

export function parseIncomingMessage(body: unknown): ParsedIncomingMessage | null {
  try {
    const payload = body as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
            messages?: Array<{
              from: string;
              id: string;
              timestamp: string;
              type: string;
              text?: { body: string };
            }>;
          };
        }>;
      }>;
    };

    const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages;
    const contacts = payload?.entry?.[0]?.changes?.[0]?.value?.contacts;

    if (!messages || messages.length === 0) return null;

    const msg = messages[0];
    const contact = contacts?.[0];

    return {
      senderPhone: msg.from,
      senderName: contact?.profile?.name ?? null,
      messageText: msg.text?.body ?? '',
      messageType: msg.type,
      messageId: msg.id,
      timestamp: parseInt(msg.timestamp, 10),
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

  const broadcastMatch = trimmed.match(/^\/broadcast\s+([\s\S]+)$/i);
  if (broadcastMatch) {
    return { command: 'broadcast', args: broadcastMatch[1].trim() };
  }

  return null;
}
