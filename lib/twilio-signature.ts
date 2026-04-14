// ============================================================
// Twilio webhook signature validation (no SDK dependency).
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
// ============================================================
//
// Twilio signs each webhook with HMAC-SHA1 of:
//   URL + concatenated (key+value) pairs of POST params in lex order
// using TWILIO_AUTH_TOKEN as the key, then base64-encoded.
// Header: X-Twilio-Signature.

import { createHmac, timingSafeEqual } from 'crypto';

export function verifyTwilioSignature(
  authToken: string,
  signatureHeader: string | null,
  url: string,
  params: Record<string, string>
): boolean {
  if (!signatureHeader || !authToken) return false;

  // Concatenate sorted key+value pairs
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];

  const expected = createHmac('sha1', authToken).update(data).digest('base64');

  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
