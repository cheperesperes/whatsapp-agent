import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { notifyOrder } from '@/lib/order-notify';
import { fedexConfigured, trackFedex } from '@/lib/fedex';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Delivery alert — "Your package arrived at your door 📦" WhatsApp to the buyer.
//
// DECOUPLED from detection: this cron reacts to any order whose fulfillment_status
// has been set to 'delivered' — by an operator marking it, a storefront sync, or a
// carrier/tracking webhook (whatever sets it). For each freshly-delivered, paid
// order with a reachable phone, it sends the delivered notification via
// lib/order-notify. Idempotent: notifyOrder logs a [NOTIFY:delivered:ref] sentinel
// in-thread and returns skipped='already_notified' on re-runs.
//
// SAFE BY DEFAULT: unless DELIVERY_ALERTS_ENABLED=true, every run is DRY-RUN
// (lists candidates, sends NOTHING).
//
// ⚠️ Delivery usually fires days after the customer's last message → OUTSIDE the
// 24h WhatsApp free-form window → notifyOrder falls back to the approved Meta
// template (ORDER_UPDATE_TEMPLATE). Without that template configured the send is
// reported as failed (never throws). Configure the template for this to deliver.
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 21;
const MAX_PER_RUN = 40;

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return true;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anon) {
    const sb = createServerClient(url, anon, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) return true;
  }
  if (!secret && process.env.VERCEL_ENV !== 'production') return true;
  return false;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const enabled = (process.env.DELIVERY_ALERTS_ENABLED ?? '').toLowerCase() === 'true';
  const sb = createServiceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // ── Phase 1 — DETECT delivery via the FedEx Track API ──────────────────────
  // Poll still-"shipped" FedEx shipments; when FedEx reports Delivered, flip the
  // order's fulfillment_status so the alert phase below picks it up. This is the
  // auto-detection that makes the alert fully hands-off. Dormant unless
  // FEDEX_API_KEY + FEDEX_SECRET_KEY are set. (UPS/other carriers: TODO, same shape.)
  let detected = 0;
  if (fedexConfigured()) {
    const { data: shipped } = await sb
      .from('orders')
      .select('order_number, tracking_number')
      .eq('fulfillment_status', 'shipped')
      .ilike('shipping_carrier', '%fedex%')
      .not('tracking_number', 'is', null)
      .gte('created_at', since)
      .limit(MAX_PER_RUN);
    for (const o of shipped ?? []) {
      const tn = (o.tracking_number ?? '').trim();
      if (!tn || !o.order_number) continue;
      const st = await trackFedex(tn);
      if (st?.delivered) {
        await sb
          .from('orders')
          .update({ fulfillment_status: 'delivered', updated_at: new Date().toISOString() })
          .eq('order_number', o.order_number);
        detected++;
        console.log(`[delivery-alerts] FedEx delivered → marked ${o.order_number} (${tn})`);
      }
    }
  }

  // ── Phase 2 — ALERT (send the "📦 it arrived" WhatsApp for delivered orders) ─
  const { data, error } = await sb
    .from('orders')
    .select('order_number, customer_phone, fulfillment_status, payment_status, paid_at, created_at')
    .eq('fulfillment_status', 'delivered')
    .gte('created_at', since)
    .not('customer_phone', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_PER_RUN);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Paid only — never message a delivery alert for an unpaid/cancelled row.
  const orders = (data ?? []).filter(
    (o) =>
      o.order_number &&
      (o.payment_status === 'paid' || o.payment_status === 'completed' || o.paid_at != null)
  );

  const sent: string[] = [];
  const skipped: Array<{ order: string; reason: string }> = [];

  for (const o of orders) {
    const ref = o.order_number as string;
    if (!enabled) {
      skipped.push({ order: ref, reason: 'dry_run' });
      continue;
    }
    const r = await notifyOrder({ orderNumber: ref, type: 'delivered' });
    if (r.sent) sent.push(ref);
    else skipped.push({ order: ref, reason: r.skipped ?? r.error ?? 'unknown' });
  }

  console.log(
    `[delivery-alerts] enabled=${enabled} fedex=${fedexConfigured()} newly_detected=${detected} delivered_candidates=${orders.length} sent=${sent.length}`
  );
  return NextResponse.json({
    ok: true,
    enabled,
    fedex_configured: fedexConfigured(),
    lookback_days: LOOKBACK_DAYS,
    newly_detected_delivered: detected,
    delivered_candidates: orders.length,
    sent,
    skipped,
  });
}
