import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { notifyOrder } from '@/lib/order-notify';
import { trackingConfigured, carrierSlug, createTracking, getTracking } from '@/lib/tracking';

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

  // ── Phase 1 — DETECT delivery via AfterShip (track by number, no carrier acct) ─
  // Poll still-"shipped" orders that have a tracking number; AfterShip tracks the
  // number across carriers (auto-detecting the courier) and reports "Delivered" → we
  // flip fulfillment_status so the alert phase below picks it up. We create the
  // AfterShip tracking once and stash its id on orders.fulfillment_data so later runs
  // just re-read it (AfterShip fetches the carrier asynchronously, so the first
  // create is usually still "Pending"; a later run sees "Delivered"). This is the
  // auto-detection that makes the alert hands-off. Dormant unless AFTERSHIP_API_KEY
  // is set. PECRON ships from its own account — we only read status, never ship.
  let detected = 0;
  if (trackingConfigured()) {
    const { data: shipped } = await sb
      .from('orders')
      .select('order_number, tracking_number, shipping_carrier, fulfillment_data')
      .eq('fulfillment_status', 'shipped')
      .not('tracking_number', 'is', null)
      .gte('created_at', since)
      .limit(MAX_PER_RUN);
    for (const o of shipped ?? []) {
      const tn = (o.tracking_number ?? '').trim();
      if (!tn || !o.order_number) continue;
      const fd =
        o.fulfillment_data && typeof o.fulfillment_data === 'object' && !Array.isArray(o.fulfillment_data)
          ? (o.fulfillment_data as Record<string, unknown>)
          : {};
      const existingId = typeof fd.aftership_id === 'string' ? fd.aftership_id : null;

      const state = existingId
        ? await getTracking(existingId)
        : await createTracking(tn, carrierSlug(o.shipping_carrier));
      if (!state) continue;

      // First sight: remember the AfterShip id so future runs just re-read it.
      if (!existingId && state.id) {
        await sb
          .from('orders')
          .update({ fulfillment_data: { ...fd, aftership_id: state.id } })
          .eq('order_number', o.order_number);
      }

      if (state.delivered) {
        await sb
          .from('orders')
          .update({ fulfillment_status: 'delivered', updated_at: new Date().toISOString() })
          .eq('order_number', o.order_number);
        detected++;
        console.log(`[delivery-alerts] AfterShip delivered → marked ${o.order_number} (${tn})`);
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
    `[delivery-alerts] enabled=${enabled} tracking=${trackingConfigured()} newly_detected=${detected} delivered_candidates=${orders.length} sent=${sent.length}`
  );
  return NextResponse.json({
    ok: true,
    enabled,
    tracking_configured: trackingConfigured(),
    lookback_days: LOOKBACK_DAYS,
    newly_detected_delivered: detected,
    delivered_candidates: orders.length,
    sent,
    skipped,
  });
}
