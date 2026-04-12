/**
 * WhatsApp Cloud API Helper Functions
 * Handles message sending and operator alerts via Meta's WhatsApp Business Platform
 */

const WHATSAPP_API_VERSION = 'v21.0';
const WHATSAPP_GRAPH_URL = 'https://graph.facebook.com';

/**
 * Send a WhatsApp message to a customer
 * @param to - Customer phone number in E.164 format (e.g., "+15551234567")
 * @param body - Message text content (max 4096 characters)
 * @returns Promise with message ID and status
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string
): Promise<{ messageId: string; status: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'Missing WhatsApp environment variables: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN'
    );
  }

  if (!to || !body) {
    throw new Error('Both "to" and "body" parameters are required');
  }

  const url = `${WHATSAPP_GRAPH_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {
          body: body,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `WhatsApp API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();

    return {
      messageId: data.messages[0]?.id || 'unknown',
      status: 'sent',
    };
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

/**
 * Send a HANDOFF alert to the operator
 * Notifies operators that a customer conversation needs escalation
 * @param customerPhone - Customer phone number in E.164 format
 * @param reason - Brief reason for escalation
 * @param lastMessage - Last customer message for context
 * @returns Promise with message ID and status
 */
export async function sendOperatorAlert(
  customerPhone: string,
  reason: string,
  lastMessage: string
): Promise<{ messageId: string; status: string }> {
  const operatorPhone = process.env.OPERATOR_PHONE || '+15617024893';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'Missing WhatsApp environment variables: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN'
    );
  }

  // Format the alert message with emojis for visual clarity
  const alertMessage = `🚨 HANDOFF ALERT 🚨

👤 Customer: ${customerPhone}
📌 Reason: ${reason}
💬 Last message: "${lastMessage}"

⏰ Timestamp: ${new Date().toISOString()}`;

  const url = `${WHATSAPP_GRAPH_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: operatorPhone,
        type: 'text',
        text: {
          body: alertMessage,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `WhatsApp API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();

    return {
      messageId: data.messages[0]?.id || 'unknown',
      status: 'sent',
    };
  } catch (error) {
    console.error('Error sending operator alert:', error);
    throw error;
  }
}

/**
 * Verify WhatsApp webhook signature
 * Use this in your webhook endpoint to validate requests from Meta
 * @param signature - X-Hub-Signature header from webhook
 * @param body - Raw request body as string
 * @returns boolean indicating if signature is valid
 */
export function verifyWebhookSignature(signature: string, body: string): boolean {
  const crypto = require('crypto');
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    console.warn('WHATSAPP_APP_SECRET not configured - signature verification skipped');
    return true;
  }

  const expectedSignature = `sha1=${crypto
    .createHmac('sha1', appSecret)
    .update(body)
    .digest('hex')}`;

  return signature === expectedSignature;
}
