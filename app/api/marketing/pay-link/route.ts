import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { createPayLink, isPayPalConfigured, type PayLinkItem } from '@/lib/marketing/paypal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Generate a PayPal exact-total guest-checkout pay-link for a set of SKUs+qty.
// Prices are looked up SERVER-SIDE from agent_product_catalog so the total can't
// be tampered by the caller. Session-authed (dashboard); CRON_SECRET also
// accepted so the agent layer can call it internally later.

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('x-internal-secret') === secret) return true;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }
  const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

interface ReqItem { sku: string; qty: number }

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isPayPalConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'PayPal no configurado. Falta PAYPAL_CLIENT_ID / PAYPAL_SECRET en Vercel.' },
      { status: 503 },
    );
  }

  let body: { items?: ReqItem[]; shipping?: number; note?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const reqItems = (body.items ?? []).filter((i) => i && i.sku && Number(i.qty) > 0);
  if (!reqItems.length) {
    return NextResponse.json({ error: 'items required: [{sku, qty}]' }, { status: 400 });
  }

  // Server-side price lookup (authoritative; applies active discount).
  const sb = createServiceClient();
  const skus = reqItems.map((i) => i.sku.toUpperCase());
  const { data: rows, error } = await sb
    .from('agent_product_catalog')
    .select('sku, name, sell_price, discount_percentage')
    .in('sku', skus)
    .eq('in_stock', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const bySku = new Map((rows ?? []).map((r: any) => [String(r.sku).toUpperCase(), r]));
  const items: PayLinkItem[] = [];
  for (const it of reqItems) {
    const row = bySku.get(it.sku.toUpperCase());
    if (!row) return NextResponse.json({ error: `SKU no disponible: ${it.sku}` }, { status: 400 });
    const disc = Number(row.discount_percentage ?? 0);
    const unit = disc > 0 ? Number(row.sell_price) * (1 - disc / 100) : Number(row.sell_price);
    if (!(unit > 0)) return NextResponse.json({ error: `Precio inválido para ${it.sku}` }, { status: 400 });
    items.push({ name: row.name, sku: row.sku, unit_price: Math.round(unit * 100) / 100, qty: Math.min(99, Math.floor(it.qty)) });
  }

  const result = await createPayLink(items, {
    shippingFlat: Math.max(0, Number(body.shipping ?? 0)),
    note: body.note,
  });
  if (!result.ok) return NextResponse.json(result, { status: 502 });

  return NextResponse.json({
    ok: true,
    url: result.url,
    order_id: result.order_id,
    total: result.total,
    items: items.map((i) => ({ sku: i.sku, qty: i.qty, unit_price: i.unit_price })),
  });
}
