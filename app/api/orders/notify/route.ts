import { NextResponse } from 'next/server';
import { notifyOrder, type OrderNotifyType } from '@/lib/order-notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/orders/notify  — operator "Notify customer" action (dashboard button).
// Admin-only: NOT in middleware PUBLIC_PATHS, so it requires a Supabase session
// (same protection as /api/conversations/[id]/send).
//
// Body: {
//   orderNumber: string,                         // e.g. "ORD-260606-414ZJX"
//   type?: 'shipped' | 'thanks' | 'custom',      // default 'shipped'
//   text?: string,                               // required when type='custom'
//   force?: boolean                              // resend even if already notified
// }
//
// 'shipped' pulls tracking_number / tracking_url / shipping_carrier from the order
// and messages the buyer's WhatsApp. Free-form inside the 24h window; an approved
// Meta template (ORDER_UPDATE_TEMPLATE) is used outside it.
const VALID_TYPES: OrderNotifyType[] = ['shipped', 'thanks', 'delivered', 'custom'];

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    orderNumber?: string;
    type?: OrderNotifyType;
    text?: string;
    force?: boolean;
    phone?: string; // override for orders with no stamped customer_phone
  };

  const orderNumber = (body.orderNumber ?? '').trim();
  if (!orderNumber) {
    return NextResponse.json({ ok: false, error: 'orderNumber is required' }, { status: 400 });
  }

  const type: OrderNotifyType = body.type ?? 'shipped';
  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ ok: false, error: `type must be one of ${VALID_TYPES.join(', ')}` }, { status: 400 });
  }
  if (type === 'custom' && !(body.text ?? '').trim()) {
    return NextResponse.json({ ok: false, error: 'text is required when type=custom' }, { status: 400 });
  }

  const result = await notifyOrder({
    orderNumber,
    type,
    customText: body.text,
    force: body.force === true,
    phoneOverride: body.phone?.trim() || undefined,
  });

  const status = result.ok ? 200 : result.error === 'order_not_found' ? 404 : 422;
  return NextResponse.json(result, { status });
}
