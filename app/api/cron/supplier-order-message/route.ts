// ─────────────────────────────────────────────────────────────────────────────
// Supplier order message — every paid store order → one WhatsApp to the operator
// with the supplier-ready text (lib/supplier-order.ts). The owner only forwards
// it to the supplier.
//
// Idempotent through public.order_supplier_notices (one row per order_number):
// an order is messaged once. Orders paid before this shipped were pre-seeded in
// that table, so nothing old is re-sent. ?dry=1 shows what would be sent.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { sendMetaWhatsAppMessage } from '@/lib/whatsapp-meta';
import { buildSupplierOrderMessage, type SupplierOrderRow } from '@/lib/supplier-order';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const LOOKBACK_DAYS = 7;
const MAX_PER_RUN = 10;

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
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const sb = createServiceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: orders, error: oErr } = await sb
    .from('orders')
    .select('order_number, customer_name, customer_phone, shipping_address, items, paid_at, created_at')
    .eq('payment_status', 'paid')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (oErr) return NextResponse.json({ ok: false, error: oErr.message }, { status: 500 });

  const numbers = (orders ?? []).map((o) => o.order_number as string);
  const { data: done, error: dErr } = numbers.length
    ? await sb.from('order_supplier_notices').select('order_number').in('order_number', numbers)
    : { data: [], error: null };
  // Fail closed: if we cannot tell what was already sent, send nothing.
  if (dErr) return NextResponse.json({ ok: false, error: dErr.message }, { status: 500 });
  const sent = new Set((done ?? []).map((r) => r.order_number as string));

  const results: Array<{ order: string; action: string }> = [];
  let count = 0;
  for (const o of (orders ?? []) as unknown as SupplierOrderRow[]) {
    if (sent.has(o.order_number)) continue;
    if (count >= MAX_PER_RUN) { results.push({ order: o.order_number, action: 'deferred' }); continue; }
    const text = buildSupplierOrderMessage(o);
    if (!text) { results.push({ order: o.order_number, action: 'skip:incomplete' }); continue; }
    if (dryRun) { results.push({ order: o.order_number, action: 'would_send' }); continue; }

    // Claim first (unique order_number) so two overlapping runs never double-send.
    const { error: claimErr } = await sb
      .from('order_supplier_notices')
      .insert({ order_number: o.order_number, status: 'sending' });
    if (claimErr) { results.push({ order: o.order_number, action: 'skip:claimed' }); continue; }
    try {
      const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN ?? '';
      const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
      if (!accessToken || !phoneNumberId) throw new Error('missing Meta WhatsApp env vars');
      // Digits only: a stray space, dash or line break in the configured number must not reach Meta.
      const to = OPERATOR_PHONE.replace(/\D/g, '');
      const r = await sendMetaWhatsAppMessage(to, text, phoneNumberId, accessToken);
      // Keep Meta's message id so the delivery report (webhook) can be matched to this order.
      await sb.from('order_supplier_notices')
        .update({
          status: 'sent', sent_at: new Date().toISOString(), wamid: r.wamid ?? null, delivery: 'accepted',
          detail: { to_last4: to.slice(-4), to_len: to.length, wa_id_last4: (r.waId ?? '').slice(-4), sender_id_last4: phoneNumberId.slice(-4) },
        })
        .eq('order_number', o.order_number);
      results.push({ order: o.order_number, action: 'sent' });
      count++;
    } catch (e) {
      // Release the claim so the next run retries.
      await sb.from('order_supplier_notices').delete().eq('order_number', o.order_number);
      results.push({ order: o.order_number, action: `error:${(e as Error).message.slice(0, 80)}` });
    }
  }

  const summary = { ok: true, dryRun, paid_in_window: numbers.length, already_done: sent.size, results };
  console.log('[supplier-order-message]', JSON.stringify(summary));
  return NextResponse.json(summary);
}
