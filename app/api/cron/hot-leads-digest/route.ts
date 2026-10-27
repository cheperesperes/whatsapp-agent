// ─────────────────────────────────────────────────────────────────────────────
// Morning hot-leads digest → operator WhatsApp.
//
// Sol scores every conversation (hot / warm / cold + a recommended action),
// but nobody was reading the Pipeline tab: 35 hot leads scored, 1 conversion
// marked. This cron sends ONE WhatsApp to the operator each morning listing
// the leads worth a personal touch today:
//   • hot or warm, scored in the last 48h, not converted, not opted out
//   • plus any unresolved handoffs from the last 7 days
// Each line: name/phone · product · last customer message · what to do.
// Nothing is sent when the list is empty. Idempotent per day via app_config
// key `hot_leads_digest_last_sent` (YYYY-MM-DD).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const MAX_LEADS = 12;
const CONFIG_KEY = 'hot_leads_digest_last_sent';

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

interface Lead {
  id: string;
  phone_number: string | null;
  customer_name: string | null;
  channel: string | null;
  lead_quality: string | null;
  recommended_action: string | null;
  product_interest: string | null;
  lead_scored_at: string | null;
  updated_at: string;
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function short(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const force = req.nextUrl.searchParams.get('force') === '1';
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const sb = createServiceClient();
  const today = todayET();

  if (!force && !dryRun) {
    const { data: cfg } = await sb.from('app_config').select('value').eq('key', CONFIG_KEY).maybeSingle();
    if (cfg && String(cfg.value) === today) {
      return NextResponse.json({ ok: true, skipped: 'already_sent_today' });
    }
  }

  const since48h = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: leads, error } = await sb
    .from('conversations')
    .select('id, phone_number, customer_name, channel, lead_quality, recommended_action, product_interest, lead_scored_at, updated_at')
    .in('lead_quality', ['hot', 'warm'])
    .gte('lead_scored_at', since48h)
    .is('converted_at', null)
    .eq('opted_out', false)
    .order('lead_quality', { ascending: true }) // 'hot' < 'warm'
    .order('lead_scored_at', { ascending: false })
    .limit(MAX_LEADS);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const { data: handoffs } = await sb
    .from('handoffs')
    .select('conversation_id, reason, last_customer_message, created_at')
    .eq('resolved', false)
    .gte('created_at', since7d)
    .order('created_at', { ascending: false })
    .limit(6);

  const list = (leads ?? []) as Lead[];
  if (list.length === 0 && (handoffs ?? []).length === 0) {
    return NextResponse.json({ ok: true, skipped: 'nothing_to_report' });
  }

  // Last customer message per lead (one query each; ≤12).
  const lines: string[] = [];
  let n = 0;
  for (const l of list) {
    n += 1;
    const { data: last } = await sb
      .from('messages')
      .select('content')
      .eq('conversation_id', l.id)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1);
    const who = l.customer_name ? `${l.customer_name}` : 'Sin nombre';
    const contact = l.phone_number && !l.phone_number.startsWith('web::') ? l.phone_number : 'chat web';
    const flag = l.lead_quality === 'hot' ? '🔥' : '🟠';
    lines.push(
      `${n}. ${flag} ${who} · ${contact}` +
        (l.product_interest ? ` · ${short(l.product_interest, 40)}` : '') +
        `\n   "${short(last?.[0]?.content as string, 90)}"` +
        (l.recommended_action ? `\n   → ${short(l.recommended_action, 140)}` : '')
    );
  }

  const hlines = (handoffs ?? []).map(
    (h) => `• ${short(h.reason as string, 60)} — "${short(h.last_customer_message as string, 80)}"`
  );

  const text = [
    `☀️ Leads para hoy (${today})`,
    `${list.filter((l) => l.lead_quality === 'hot').length} calientes · ${list.filter((l) => l.lead_quality === 'warm').length} tibios`,
    '',
    ...lines,
    ...(hlines.length ? ['', `⚠️ Escalados sin resolver (${hlines.length}):`, ...hlines] : []),
    '',
    'Responde desde el panel → Conversaciones. /bot <tel> devuelve el hilo a Sol.',
  ].join('\n');

  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, text, leads: list.length, handoffs: hlines.length });

  await sendWhatsAppMessage(OPERATOR_PHONE, text);
  await sb.from('app_config').upsert({ key: CONFIG_KEY, value: today }, { onConflict: 'key' });
  console.log(`[hot-leads-digest] sent ${list.length} leads, ${hlines.length} handoffs to operator`);
  return NextResponse.json({ ok: true, sent: true, leads: list.length, handoffs: hlines.length });
}
