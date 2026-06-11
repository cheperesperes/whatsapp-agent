import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import {
  buildManualChaseDraft,
  extractProductModel,
  PRODUCT_QUOTE_RE,
  PAYLINK_SENT_RE,
} from '@/lib/followup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Sales pipeline overview — powers /dashboard/pipeline.
//
// Derives each recent WhatsApp conversation's funnel stage LIVE (no schema
// state to drift):
//   needs_reply — last message is the CUSTOMER's → Sol/operator owes a reply.
//   hot         — quoted, customer silent, <24h window still open (the
//                 automated nudge ladder is active on these).
//   chase       — quoted, silent >24h → free-form API window closed; operator
//                 sends the suggested copy manually from the WhatsApp app.
//   browsing    — chatting but never received a quote.
//   converted   — an order matches the phone after the conversation started.
// Session-gated by middleware like the rest of /api (NOT in PUBLIC_PATHS).
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 14;
const MAX_CONVERSATIONS = 120;
const MESSAGE_TAIL = 12;
const BATCH = 15;

function phoneKey(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.slice(-10);
}

interface ConvRow {
  id: string;
  phone_number: string;
  customer_name: string | null;
  product_interest: string | null;
  converted_at: string | null;
  escalated: boolean;
  opted_out: boolean;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export interface PipelineRow {
  conversation_id: string;
  phone: string;
  name: string | null;
  sku: string | null;
  paylink_sent: boolean;
  hours_silent: number | null;
  last_user_at: string | null;
  nudges: Array<{ kind: string; created_at: string }>;
  next_auto_touch: string | null;
  suggested_es?: string;
  suggested_en?: string;
  wa_link: string;
  order_total?: number;
}

export async function GET() {
  const supabase = createServiceClient();
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [convRes, orderRes, ledgerRes] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, phone_number, customer_name, product_interest, converted_at, escalated, opted_out, created_at, updated_at')
      .eq('channel', 'whatsapp')
      .not('phone_number', 'is', null)
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(MAX_CONVERSATIONS),
    supabase
      .from('orders')
      .select('customer_phone, total, created_at')
      .gte('created_at', since)
      .not('customer_phone', 'is', null),
    supabase
      .from('sol_followups')
      .select('conversation_id, kind, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true }),
  ]);

  if (convRes.error) {
    return NextResponse.json({ ok: false, error: convRes.error.message }, { status: 500 });
  }

  const convs = (convRes.data ?? []) as ConvRow[];
  const orders = (orderRes.data ?? []) as Array<{ customer_phone: string; total: number | null; created_at: string }>;
  const ledger = (ledgerRes.data ?? []) as Array<{ conversation_id: string; kind: string; created_at: string }>;

  const ordersByPhone = new Map<string, Array<{ total: number | null; created_at: string }>>();
  for (const o of orders) {
    const k = phoneKey(o.customer_phone);
    if (!k) continue;
    if (!ordersByPhone.has(k)) ordersByPhone.set(k, []);
    ordersByPhone.get(k)!.push({ total: o.total, created_at: o.created_at });
  }
  const ledgerByConv = new Map<string, Array<{ kind: string; created_at: string }>>();
  for (const l of ledger) {
    if (!ledgerByConv.has(l.conversation_id)) ledgerByConv.set(l.conversation_id, []);
    ledgerByConv.get(l.conversation_id)!.push({ kind: l.kind, created_at: l.created_at });
  }

  // Tails in parallel batches — bounded, predictable load.
  const tails = new Map<string, MessageRow[]>();
  for (let i = 0; i < convs.length; i += BATCH) {
    const batch = convs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((c) =>
        supabase
          .from('messages')
          .select('role, content, created_at')
          .eq('conversation_id', c.id)
          .order('created_at', { ascending: false })
          .limit(MESSAGE_TAIL)
          .then((r) => ({ id: c.id, msgs: (r.data ?? []) as MessageRow[] }))
      )
    );
    for (const r of results) tails.set(r.id, r.msgs);
  }

  const buckets: Record<'needs_reply' | 'hot' | 'chase' | 'browsing' | 'converted', PipelineRow[]> = {
    needs_reply: [],
    hot: [],
    chase: [],
    browsing: [],
    converted: [],
  };
  let escalatedCount = 0;
  let optedOutCount = 0;

  for (const c of convs) {
    if (c.opted_out) {
      optedOutCount++;
      continue;
    }

    const msgs = tails.get(c.id) ?? [];
    if (msgs.length === 0) continue;
    const lastMsg = msgs[0];
    const lastUser = msgs.find((m) => m.role === 'user');
    const quoteMsg = msgs.find((m) => m.role === 'assistant' && PRODUCT_QUOTE_RE.test(m.content));
    const paylinkSent = msgs.some((m) => m.role === 'assistant' && PAYLINK_SENT_RE.test(m.content));
    const sku =
      (paylinkSent || quoteMsg ? extractProductModel((quoteMsg ?? lastMsg).content) : null) ??
      c.product_interest;
    const nudges = ledgerByConv.get(c.id) ?? [];
    const userAgeH = lastUser ? (now - Date.parse(lastUser.created_at)) / (60 * 60 * 1000) : null;
    const digits = (c.phone_number ?? '').replace(/\D/g, '');

    const row: PipelineRow = {
      conversation_id: c.id,
      phone: c.phone_number,
      name: c.customer_name,
      sku,
      paylink_sent: paylinkSent,
      hours_silent: userAgeH === null ? null : Math.round(userAgeH * 10) / 10,
      last_user_at: lastUser?.created_at ?? null,
      nudges,
      next_auto_touch: null,
      wa_link: `https://wa.me/${digits}`,
    };

    // Converted: order from this phone at/after the conversation started, or
    // an explicit converted_at stamp.
    const phoneOrders = ordersByPhone.get(phoneKey(c.phone_number)) ?? [];
    const matchedOrder = phoneOrders.find((o) => Date.parse(o.created_at) >= Date.parse(c.created_at));
    if (c.converted_at || matchedOrder) {
      row.order_total = matchedOrder?.total ?? undefined;
      buckets.converted.push(row);
      continue;
    }

    if (c.escalated) {
      escalatedCount++;
      continue;
    }

    if (lastMsg.role === 'user') {
      buckets.needs_reply.push(row);
      continue;
    }

    if (!quoteMsg && !paylinkSent) {
      buckets.browsing.push(row);
      continue;
    }

    if (userAgeH !== null && userAgeH <= 24) {
      // Automated ladder still active — say which touch comes next.
      if (nudges.length === 0) {
        row.next_auto_touch = userAgeH < 2 ? 'toque 1 (2-6h)' : userAgeH <= 6 ? 'toque 1 — en esta ventana' : 'toque 2 (18-23h)';
      } else if (nudges.length === 1) {
        row.next_auto_touch = userAgeH < 18 ? 'toque 2 (18-23h)' : 'toque 2 — en esta ventana';
      } else {
        row.next_auto_touch = 'ladder completo — pasa a manual mañana';
      }
      buckets.hot.push(row);
      continue;
    }

    // Window closed → manual chase with suggested copy (both languages; the
    // operator picks). Sent from the WhatsApp app, not the API.
    row.suggested_es = buildManualChaseDraft({ customerName: c.customer_name, sku, language: 'es' });
    row.suggested_en = buildManualChaseDraft({ customerName: c.customer_name, sku, language: 'en' });
    buckets.chase.push(row);
  }

  // Hottest first inside each bucket: pay-link > nudged > recently silent.
  buckets.hot.sort((a, b) => Number(b.paylink_sent) - Number(a.paylink_sent) || (a.hours_silent ?? 99) - (b.hours_silent ?? 99));
  buckets.chase.sort((a, b) => (a.hours_silent ?? 999) - (b.hours_silent ?? 999));

  return NextResponse.json({
    ok: true,
    lookback_days: LOOKBACK_DAYS,
    enabled: {
      sales_followup: (process.env.SALES_FOLLOWUP_ENABLED ?? '').toLowerCase() === 'true',
      paylink_nudge: (process.env.PAYLINK_NUDGE_ENABLED ?? '').toLowerCase() === 'true',
      followup_cron: (process.env.FOLLOWUP_CRON_ENABLED ?? 'true').toLowerCase() !== 'false',
    },
    counts: {
      needs_reply: buckets.needs_reply.length,
      hot: buckets.hot.length,
      chase: buckets.chase.length,
      browsing: buckets.browsing.length,
      converted: buckets.converted.length,
      escalated: escalatedCount,
      opted_out: optedOutCount,
    },
    buckets,
  });
}
