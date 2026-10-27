// ─────────────────────────────────────────────────────────────────────────────
// Orders → conversations link — closes the funnel automatically.
//
// Pipeline/Scorecard count conversions by conversations.converted_at, which
// until now was only set by hand (/won or the dashboard button): 583
// conversations, 1 marked converted, while 20 orders were paid in 2026. This
// cron matches every PAID order to the WhatsApp conversation with the same
// phone (last 10 digits of customer_phone / sender_phone) and stamps
// converted_at = paid_at on the latest conversation that started BEFORE the
// order. Idempotent: already-converted conversations are left alone, and a
// [CONVERSION:<order_number>] sentinel message is written so a re-run never
// double-counts the same order.
//
// Web conversations have no phone, so they are only matched when the visitor
// shared a phone number that Sol stored on the conversation.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const LOOKBACK_DAYS = 120;

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

function key(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_phone: string | null;
  sender_phone: string | null;
  paid_at: string | null;
  created_at: string;
  total: number | string | null;
}

interface ConvRow {
  id: string;
  phone_number: string | null;
  created_at: string;
  converted_at: string | null;
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
    .select('id, order_number, customer_phone, sender_phone, paid_at, created_at, total')
    .eq('payment_status', 'paid')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (oErr) return NextResponse.json({ ok: false, error: oErr.message }, { status: 500 });

  // Orders already linked (sentinel message exists).
  const { data: sentinels } = await sb
    .from('messages')
    .select('content')
    .like('content', '[CONVERSION:%')
    .gte('created_at', since);
  const linked = new Set<string>(
    (sentinels ?? []).map((m) => (m.content as string).replace(/^\[CONVERSION:([^\]]+)\].*$/, '$1'))
  );

  const results: Array<{ order: string; conversation?: string; action: string }> = [];

  for (const o of (orders ?? []) as OrderRow[]) {
    if (linked.has(o.order_number)) continue;
    const phones = [key(o.customer_phone), key(o.sender_phone)].filter((p): p is string => !!p);
    if (phones.length === 0) {
      results.push({ order: o.order_number, action: 'skip:no_phone' });
      continue;
    }
    const paidAt = o.paid_at ?? o.created_at;

    // Conversations whose phone ends with the order phone, started before payment.
    const { data: convs } = await sb
      .from('conversations')
      .select('id, phone_number, created_at, converted_at')
      .lte('created_at', paidAt)
      .or(phones.map((p) => `phone_number.ilike.%${p}`).join(','))
      .order('created_at', { ascending: false })
      .limit(1);
    const conv = (convs ?? [])[0] as ConvRow | undefined;
    if (!conv) {
      results.push({ order: o.order_number, action: 'skip:no_conversation' });
      continue;
    }

    if (dryRun) {
      results.push({ order: o.order_number, conversation: conv.id, action: conv.converted_at ? 'would_link_only' : 'would_convert' });
      continue;
    }

    if (!conv.converted_at) {
      await sb
        .from('conversations')
        .update({ converted_at: paidAt, updated_at: new Date().toISOString() })
        .eq('id', conv.id);
    }
    await sb.from('messages').insert({
      conversation_id: conv.id,
      role: 'system',
      content: `[CONVERSION:${o.order_number}] pedido pagado ${paidAt.slice(0, 10)} · total $${Number(o.total ?? 0).toFixed(2)}`,
      handoff_detected: false,
    });
    results.push({ order: o.order_number, conversation: conv.id, action: conv.converted_at ? 'linked' : 'converted' });
  }

  const summary = {
    ok: true,
    dryRun,
    orders_paid_in_window: (orders ?? []).length,
    already_linked: linked.size,
    converted: results.filter((r) => r.action === 'converted').length,
    linked: results.filter((r) => r.action === 'linked').length,
    skipped: results.filter((r) => r.action.startsWith('skip')).length,
    results,
  };
  console.log('[order-conversions]', JSON.stringify({ ...summary, results: undefined }));
  return NextResponse.json(summary);
}
