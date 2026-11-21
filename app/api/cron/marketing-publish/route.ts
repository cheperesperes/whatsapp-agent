// ─────────────────────────────────────────────────────────────────────────────
// Marketing publisher — publishes the posts the owner approved on the weekly plan.
//
//   (default)      every day 15:00 UTC (10 AM ET): each campaign with status
//                  'approved' whose date has arrived goes out through the same
//                  publish path as the dashboard button (/api/marketing/approve).
//                  A post whose product is no longer in stock is NOT published:
//                  it is marked 'expired' with the reason.
//   ?mode=notify   Sunday, after the week is generated: one WhatsApp to the
//                  operator with the number of posts waiting and the link.
//
// Nothing is ever published here that the owner did not approve.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'nodejs';
export const maxDuration = 300;

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const MAX_PER_RUN = 2; // each publish can take up to ~2 min

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return true;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anon) {
    const sb = createServerClient(url, anon, { cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} } });
    const { data: { user } } = await sb.auth.getUser();
    if (user) return true;
  }
  if (!secret && process.env.VERCEL_ENV !== 'production') return true;
  return false;
}

// The owner's calendar day (Eastern), so a post dated Monday goes out on his Monday.
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export async function GET(req: NextRequest): Promise<Response> {
  if (!(await isAuthorized(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const sb = createServiceClient();
  const origin = req.nextUrl.origin;
  const today = todayET();

  if (req.nextUrl.searchParams.get('mode') === 'notify') {
    const { data: pending } = await sb
      .from('marketing_campaigns')
      .select('id')
      .eq('status', 'pending_approval')
      .gte('date', today);
    const n = pending?.length ?? 0;
    if (n === 0) return NextResponse.json({ ok: true, mode: 'notify', pending: 0, sent: false });
    let sent = true;
    try {
      await sendWhatsAppMessage(
        OPERATOR_PHONE,
        `🗓️ *Plan de la semana listo*\n${n} publicaciones esperan tu aprobación.\nRevísalas aquí (5 min): ${origin}/dashboard/marketing/semana\n\nNada se publica sin tu aprobación.`,
      );
    } catch (e) {
      sent = false;
      console.warn('[marketing-publish] notify failed:', e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ ok: true, mode: 'notify', pending: n, sent });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'CRON_SECRET not set' }, { status: 500 });

  const { data: due, error } = await sb
    .from('marketing_campaigns')
    .select('id, date, product_sku, language')
    .eq('status', 'approved')
    .lte('date', today)
    .order('date', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Array<{ id: string; date: string; action: string }> = [];
  for (const c of due ?? []) {
    // Only promote what can be sold today.
    if (c.product_sku) {
      const { data: p } = await sb
        .from('agent_product_catalog')
        .select('in_stock')
        .eq('sku', c.product_sku)
        .maybeSingle();
      if (p && p.in_stock === false) {
        await sb.from('marketing_campaigns')
          .update({ status: 'expired', error_message: `No publicada: ${c.product_sku} está agotado el día de la publicación.` })
          .eq('id', c.id).eq('status', 'approved');
        results.push({ id: c.id, date: c.date, action: 'expired:out_of_stock' });
        continue;
      }
    }
    try {
      const res = await fetch(`${origin}/api/marketing/approve`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ campaign_id: c.id, approved: true }),
      });
      const j = (await res.json().catch(() => null)) as { status?: string; error?: string } | null;
      results.push({ id: c.id, date: c.date, action: `publish:${j?.status ?? j?.error ?? res.status}` });
    } catch (e) {
      results.push({ id: c.id, date: c.date, action: `error:${(e as Error).message.slice(0, 80)}` });
    }
  }

  const summary = { ok: true, today, due: due?.length ?? 0, results };
  console.log('[marketing-publish]', JSON.stringify(summary));
  return NextResponse.json(summary);
}
