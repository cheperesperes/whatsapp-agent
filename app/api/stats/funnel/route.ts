import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Sol conversion funnel — powers /dashboard/funnel.
//
// The number that matters: of the WhatsApp leads that arrive, how many survive
// each step. Built after the 2026-06-12 audit found the channel converting at
// ~0% with three collapse points the close-polishing never touched:
//   turn-1 reply  — did the customer send a 2nd message (survive the opener)?
//   reached link  — did Sol get a product/pay link in front of them?
//   reached paylink — did they get a real PayPal checkout link?
//   paid          — did an order from their phone actually get paid?
//
// Computed LIVE from conversations + messages + orders (no stored funnel state
// to drift). Sliced by window (7d / 30d) and by ad source so we can see whether
// each shipped fix moves the rate, and which traffic actually converts.
// Session-gated by middleware (NOT in PUBLIC_PATHS).
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 30;
const MAX_CONVERSATIONS = 600;

// "Reached pay-link" = Sol sent a CLOSE-checkout message. Two generations:
//  - legacy PayPal pay-links (retired 2026-06-28, #290);
//  - storefront Stripe close links — the URL is a plain product page, so we
//    detect the fixed close-message templates from lib/paylink.ts instead
//    (applyPayLinkMarkers + framePriceMatch). Keep in sync with those strings.
const PAYLINK_RE =
  /paypal\.com\/checkoutnow|pago seguro — elija cómo pagar|secure checkout — pick how you pay|pague seguro \(tarjeta|secure checkout \(card/i;
const PRODUCT_LINK_RE = /oiikon\.com\/product\//i;

function phoneKey(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10);
}

function sourceBucket(adSource: string | null): 'F5000' | 'E3600' | 'other_ad' | 'no_ad' {
  if (!adSource) return 'no_ad';
  if (/F5000/i.test(adSource)) return 'F5000';
  if (/E3600/i.test(adSource)) return 'E3600';
  if (/^ad/i.test(adSource) || /template:/i.test(adSource)) return 'other_ad';
  return 'other_ad';
}

interface Stage {
  convos: number;
  turn1_reply: number;
  reached_link: number;
  reached_paylink: number;
  paid: number;
}

function emptyStage(): Stage {
  return { convos: 0, turn1_reply: 0, reached_link: 0, reached_paylink: 0, paid: 0 };
}

function withRates(s: Stage) {
  const pct = (n: number) => (s.convos ? Math.round((n / s.convos) * 1000) / 10 : 0);
  return {
    ...s,
    pct_turn1_reply: pct(s.turn1_reply),
    pct_reached_link: pct(s.reached_link),
    pct_reached_paylink: pct(s.reached_paylink),
    pct_paid: pct(s.paid),
  };
}

export async function GET() {
  const supabase = createServiceClient();
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
  const since7 = now - 7 * 86_400_000;

  const convRes = await supabase
    .from('conversations')
    .select('id, phone_number, ad_source, created_at')
    .eq('channel', 'whatsapp')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_CONVERSATIONS);

  if (convRes.error) {
    return NextResponse.json({ ok: false, error: convRes.error.message }, { status: 500 });
  }
  const convs = (convRes.data ?? []) as Array<{
    id: string;
    phone_number: string | null;
    ad_source: string | null;
    created_at: string;
  }>;
  if (convs.length === 0) {
    return NextResponse.json({ ok: true, lookback_days: LOOKBACK_DAYS, windows: {}, by_source: {}, note: 'no conversations in window' });
  }

  const convIds = convs.map((c) => c.id);

  // Messages for these conversations (role + content for link/paylink detection)
  // and paid orders matched by phone. Both bounded by the same window.
  const [msgRes, orderRes] = await Promise.all([
    supabase.from('messages').select('conversation_id, role, content').in('conversation_id', convIds),
    supabase
      .from('orders')
      .select('customer_phone, payment_status, paid_at, created_at')
      .gte('created_at', since)
      .not('customer_phone', 'is', null),
  ]);

  const msgs = (msgRes.data ?? []) as Array<{ conversation_id: string; role: string; content: string | null }>;
  const orders = (orderRes.data ?? []) as Array<{
    customer_phone: string;
    payment_status: string | null;
    paid_at: string | null;
    created_at: string;
  }>;

  // Per-conversation rollup from messages.
  const stat = new Map<string, { userMsgs: number; link: boolean; paylink: boolean }>();
  for (const id of convIds) stat.set(id, { userMsgs: 0, link: false, paylink: false });
  for (const m of msgs) {
    const s = stat.get(m.conversation_id);
    if (!s) continue;
    if (m.role === 'user') s.userMsgs++;
    if (m.role === 'assistant' && m.content) {
      if (PAYLINK_RE.test(m.content)) s.paylink = true;
      if (PRODUCT_LINK_RE.test(m.content)) s.link = true;
    }
  }

  // Paid orders by phone (last-10 digits).
  const paidPhones = new Set<string>();
  for (const o of orders) {
    const paid = o.paid_at != null || ['paid', 'completed'].includes((o.payment_status ?? '').toLowerCase());
    if (paid) paidPhones.add(phoneKey(o.customer_phone));
  }

  const win7 = emptyStage();
  const win30 = emptyStage();
  const bySource: Record<string, Stage> = { F5000: emptyStage(), E3600: emptyStage(), other_ad: emptyStage(), no_ad: emptyStage() };

  for (const c of convs) {
    const s = stat.get(c.id)!;
    const isReply = s.userMsgs >= 2;
    const isPaid = paidPhones.has(phoneKey(c.phone_number));
    const apply = (st: Stage) => {
      st.convos++;
      if (isReply) st.turn1_reply++;
      if (s.link || s.paylink) st.reached_link++;
      if (s.paylink) st.reached_paylink++;
      if (isPaid) st.paid++;
    };
    apply(win30);
    if (Date.parse(c.created_at) >= since7) apply(win7);
    apply(bySource[sourceBucket(c.ad_source)]);
  }

  return NextResponse.json({
    ok: true,
    lookback_days: LOOKBACK_DAYS,
    generated_at: new Date(now).toISOString(),
    windows: { last_7d: withRates(win7), last_30d: withRates(win30) },
    by_source_30d: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, withRates(v)])),
  });
}
