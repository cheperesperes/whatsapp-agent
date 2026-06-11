import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient, loadActiveOffers, loadProductCosts, selectBestOffer } from '@/lib/supabase';
import { sendEmail, buildWebLeadFollowupEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Web-lead follow-up email — "you left something behind, how can we help?"
//
// Audience: WEB CHAT visitors who explicitly opted in via the widget's email
// card (web_lead_contacts: consent_marketing=true, exact consent wording on
// record). WhatsApp leads are NOT in scope — they have the nudge ladder.
//
// ONE email per contact, ever:
//   • contact created 2-48h ago (give them the evening; stale leads excluded)
//   • conversation quiet (last message is Sol's, not the visitor's)
//   • subscribed + never emailed (followup_sent_at null)
// Content: the product they were looking at (live name/price/link — never the
// possibly-stale quote), the best MARGIN-SAFE presentable coupon for it
// (same selectBestOffer gate Sol uses), WhatsApp CTA, one-click unsubscribe.
//
// SAFE BY DEFAULT — two independent switches must both be on to send:
//   WEB_LEAD_EMAIL_ENABLED=true   (operator intent)
//   RESEND_API_KEY                (transport configured)
// Otherwise the run is a dry-run that logs exactly what it WOULD send.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_AGE_HOURS = 2;
const MAX_AGE_HOURS = 48;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

function appBase(): string {
  const url = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return url ? `https://${url}` : 'https://whatsapp-agent-ebon-nine.vercel.app';
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const enabled = (process.env.WEB_LEAD_EMAIL_ENABLED ?? '').toLowerCase() === 'true';
  const transportReady = Boolean((process.env.RESEND_API_KEY ?? '').trim());
  const dryRun = !enabled || !transportReady || url.searchParams.get('dry') === '1';

  const supabase = createServiceClient();
  const runId = randomUUID();
  const now = Date.now();

  const newest = new Date(now - MIN_AGE_HOURS * 60 * 60 * 1000).toISOString();
  const oldest = new Date(now - MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: contacts, error: cErr } = await supabase
    .from('web_lead_contacts')
    .select('id, conversation_id, email, language, product_sku, created_at')
    .eq('status', 'subscribed')
    .eq('consent_marketing', true)
    .is('followup_sent_at', null)
    .gte('created_at', oldest)
    .lte('created_at', newest)
    .order('created_at', { ascending: true })
    .limit(50);

  if (cErr) {
    return NextResponse.json({ error: `contacts read failed: ${cErr.message}`, run_id: runId }, { status: 500 });
  }

  const pending = contacts ?? [];
  const sent: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  // Offer machinery loaded once per run.
  const [offers, costs] = pending.length > 0 ? await Promise.all([loadActiveOffers(), loadProductCosts()]) : [[], {}];

  for (const c of pending) {
    // Quiet check: if the visitor wrote after opting in, Sol is already
    // talking to them — an email would be noise.
    if (c.conversation_id) {
      const { data: lastMsg } = await supabase
        .from('messages')
        .select('role')
        .eq('conversation_id', c.conversation_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastMsg && lastMsg.role === 'user') {
        skipped.push({ id: c.id, reason: 'visitor_active' });
        continue;
      }
    }

    // Live product snapshot (never the possibly-stale chat quote). Only an
    // in-stock, active product gets pitched; otherwise send the generic
    // "your question is still open" variant.
    let productName: string | null = null;
    let productPrice: number | null = null;
    let productUrl: string | null = null;
    let couponCode: string | null = null;
    let couponSavings: number | null = null;

    if (c.product_sku) {
      const { data: p } = await supabase
        .from('products')
        .select('sku, name, slug, price, brand, in_stock, is_active')
        .eq('sku', c.product_sku)
        .maybeSingle();
      if (p && p.in_stock && p.is_active !== false) {
        productName = p.name ?? c.product_sku;
        productPrice = p.price != null ? Number(p.price) : null;
        productUrl = p.slug ? `https://oiikon.com/product/${p.slug}` : null;
        if (productPrice != null) {
          const best = selectBestOffer(productPrice, p.brand ?? null, costs[p.sku] ?? null, offers);
          if (best) {
            couponCode = best.code;
            couponSavings = best.savings;
            if (productUrl) productUrl = `${productUrl}?promo=${encodeURIComponent(best.code)}`;
          }
        }
      }
    }

    const unsubscribeUrl = `${appBase()}/api/web-leads/unsubscribe?id=${c.id}&lang=${c.language}`;
    const mail = buildWebLeadFollowupEmail({
      language: c.language === 'en' ? 'en' : 'es',
      productName,
      productPrice,
      productUrl,
      couponCode,
      couponSavings,
      unsubscribeUrl,
    });

    if (dryRun) {
      sent.push({ id: c.id, email: c.email, sku: c.product_sku, coupon: couponCode, subject: mail.subject });
      continue;
    }

    const result = await sendEmail({
      to: c.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      unsubscribeUrl,
    });

    if (result.ok) {
      await supabase
        .from('web_lead_contacts')
        .update({ followup_sent_at: new Date().toISOString() })
        .eq('id', c.id);
      sent.push({ id: c.id, email: c.email, sku: c.product_sku, coupon: couponCode, resend_id: result.id });
    } else {
      errors.push({ id: c.id, error: result.error });
    }
  }

  console.log(
    `[web-lead-followup] run=${runId} ${dryRun ? 'WOULD send' : 'sent'}=${sent.length} skipped=${skipped.length} errors=${errors.length} enabled=${enabled} transport=${transportReady}`
  );

  return NextResponse.json({
    ok: true,
    run_id: runId,
    enabled,
    transport_configured: transportReady,
    dry_run: dryRun,
    pending: pending.length,
    [dryRun ? 'would_send' : 'sent']: sent.length,
    skipped: skipped.length,
    errors: errors.length,
    details: { sent, skipped, errors },
  });
}
