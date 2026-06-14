import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/orders/list — paid orders for the Envíos (shipping) queue.
// Admin-only: NOT in middleware PUBLIC_PATHS, so it requires a Supabase session
// (same protection as /api/orders/notify).
//
// Returns recent PAID orders with their fulfillment/tracking fields so the
// operator can attach a tracking number and mark them shipped — which is what
// feeds the FedEx delivery-detection cron. Newest first, last 120 days.

const LOOKBACK_DAYS = 120;
const MAX = 100;

interface ItemLike {
  name?: unknown;
  sku?: unknown;
  quantity?: unknown;
}

function summarizeItems(items: unknown): string {
  if (!Array.isArray(items)) return '';
  const parts = items.slice(0, 6).map((raw) => {
    const it = (raw ?? {}) as ItemLike;
    const name =
      typeof it.name === 'string' && it.name.trim()
        ? it.name.trim()
        : typeof it.sku === 'string' && it.sku.trim()
          ? it.sku.trim()
          : 'Artículo';
    const qtyNum = typeof it.quantity === 'number' ? it.quantity : Number(it.quantity);
    const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1;
    return `${qty}× ${name}`;
  });
  const extra = items.length > 6 ? ` +${items.length - 6}` : '';
  return parts.join(' · ') + extra;
}

interface OrderRow {
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total: number | string | null;
  items: unknown;
  fulfillment_status: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipping_carrier: string | null;
  ship_date: string | null;
  paid_at: string | null;
  created_at: string;
}

export async function GET(): Promise<Response> {
  const sb = createServiceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data, error } = await sb
    .from('orders')
    .select(
      'order_number, customer_name, customer_phone, total, items, fulfillment_status, tracking_number, tracking_url, shipping_carrier, ship_date, paid_at, created_at',
    )
    .eq('payment_status', 'paid')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const orders = ((data ?? []) as OrderRow[])
    .filter((o) => Boolean(o.order_number))
    .map((o) => ({
      order_number: o.order_number as string,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      total: typeof o.total === 'number' ? o.total : Number(o.total) || 0,
      items_summary: summarizeItems(o.items),
      fulfillment_status: o.fulfillment_status ?? 'pending',
      tracking_number: o.tracking_number,
      tracking_url: o.tracking_url,
      shipping_carrier: o.shipping_carrier,
      ship_date: o.ship_date,
      paid_at: o.paid_at,
      created_at: o.created_at,
      has_phone: Boolean((o.customer_phone ?? '').trim()),
    }));

  return NextResponse.json({ ok: true, orders });
}
