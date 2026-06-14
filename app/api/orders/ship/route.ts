import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { notifyOrder } from '@/lib/order-notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/orders/ship — operator "Mark shipped + tracking #" action (Envíos page).
// Admin-only: NOT in middleware PUBLIC_PATHS, so it requires a Supabase session.
//
// Body: {
//   orderNumber: string,            // e.g. "ORD-260606-414ZJX"
//   trackingNumber: string,         // carrier tracking number
//   carrier?: string,               // default "FedEx"
//   trackingUrl?: string,           // auto-built for known carriers if omitted
//   notify?: boolean                // also send the customer a "shipped" WhatsApp now
// }
//
// Sets fulfillment_status='shipped' + tracking fields + ship_date. With carrier
// FedEx + a tracking number, the delivery-alerts cron then auto-detects delivery
// and fires the "📦 llegó" message. notify=true sends the shipped update now
// (free-form inside the 24h window, else the Meta ORDER_UPDATE_TEMPLATE).

function buildTrackingUrl(carrier: string, num: string): string | null {
  const c = carrier.toLowerCase();
  const enc = encodeURIComponent(num);
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${enc}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${enc}`;
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${enc}`;
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    orderNumber?: string;
    trackingNumber?: string;
    carrier?: string;
    trackingUrl?: string;
    notify?: boolean;
  };

  const orderNumber = (body.orderNumber ?? '').trim();
  const trackingNumber = (body.trackingNumber ?? '').trim();
  if (!orderNumber) return NextResponse.json({ ok: false, error: 'orderNumber is required' }, { status: 400 });
  if (!trackingNumber) return NextResponse.json({ ok: false, error: 'trackingNumber is required' }, { status: 400 });

  const carrier = (body.carrier ?? 'FedEx').trim() || 'FedEx';
  const trackingUrl = (body.trackingUrl ?? '').trim() || buildTrackingUrl(carrier, trackingNumber);

  const sb = createServiceClient();

  // Confirm the order exists before mutating (404 if not).
  const { data: existing } = await sb
    .from('orders')
    .select('order_number')
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (!existing) return NextResponse.json({ ok: false, error: 'order_not_found' }, { status: 404 });

  const { error: updErr } = await sb
    .from('orders')
    .update({
      fulfillment_status: 'shipped',
      tracking_number: trackingNumber,
      shipping_carrier: carrier,
      tracking_url: trackingUrl,
      ship_date: new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq('order_number', orderNumber);

  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  // Optional: send the customer the "shipped" WhatsApp now. Operator-initiated,
  // explicit opt-in. Never throws (notifyOrder reports its own result).
  const notify = body.notify === true ? await notifyOrder({ orderNumber, type: 'shipped' }) : undefined;

  return NextResponse.json({
    ok: true,
    orderNumber,
    fulfillment_status: 'shipped',
    tracking_number: trackingNumber,
    shipping_carrier: carrier,
    tracking_url: trackingUrl,
    notify,
  });
}
