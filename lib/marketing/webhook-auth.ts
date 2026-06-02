import { NextRequest } from 'next/server';

/**
 * Lightweight shared-secret check for provider video webhooks (Higgsfield,
 * HeyGen). These endpoints are public (the providers POST to them with no user
 * session), so we gate them on a secret passed in the URL (?key=) or the
 * `x-webhook-secret` header.
 *
 * Set MARKETING_WEBHOOK_SECRET in Vercel and append ?key=<secret> to the
 * webhook URLs registered with each provider.
 *
 * GRACEFUL ROLLOUT: if the secret isn't configured, we DON'T hard-fail (the
 * endpoints already ignore the payload body and re-fetch authoritative status
 * from the provider, so the blast radius is just a forced status refresh). We
 * log a warning so the operator knows to set it. Once set, mismatches are
 * rejected.
 */
export function checkWebhookSecret(req: NextRequest): { ok: boolean; reason?: string } {
  const expected = process.env.MARKETING_WEBHOOK_SECRET;
  if (!expected) {
    console.warn('[webhook-auth] MARKETING_WEBHOOK_SECRET not set — webhook accepted unauthenticated (set it to enable verification)');
    return { ok: true, reason: 'secret-not-configured' };
  }
  const provided =
    req.nextUrl.searchParams.get('key') ?? req.headers.get('x-webhook-secret') ?? '';
  // Constant-time-ish compare via length + char check is overkill for a webhook
  // shared secret; a direct compare is fine here since it's not a password.
  if (provided && provided === expected) return { ok: true };
  return { ok: false, reason: 'bad-or-missing-secret' };
}
