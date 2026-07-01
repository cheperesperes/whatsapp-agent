import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Manual ad-spend logging for the Negocio board. Facebook can auto-sync from
// the Meta API (see cron/social-stats), but Google Ads and WhatsApp Ads have no
// API credential here, so the operator logs weekly spend by hand. Feeds ROAS
// and the per-channel breakdown.
//
//   GET    → recent rows (last 180 days)
//   POST   → add a weekly row  { week_start, channel, spend, clicks?, impressions?, campaign?, note? }
//   DELETE ?id=… → remove a row

const CHANNELS = new Set(['facebook', 'google', 'whatsapp', 'instagram', 'tiktok', 'otro']);

async function requireUser(req: NextRequest): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return true; // local dev without Supabase env — allow
  const sb = createServerClient(url, anon, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sb = createServiceClient();
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('ad_spend')
    .select('id, week_start, channel, campaign, spend, clicks, impressions, currency, note')
    .gte('week_start', since)
    .order('week_start', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const week_start = String(body.week_start ?? '').slice(0, 10);
  const channel = String(body.channel ?? '').toLowerCase().trim();
  const spend = Number(body.spend);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
    return NextResponse.json({ error: 'week_start debe ser una fecha (YYYY-MM-DD)' }, { status: 400 });
  }
  if (!CHANNELS.has(channel)) {
    return NextResponse.json({ error: `Canal inválido. Usa: ${[...CHANNELS].join(', ')}` }, { status: 400 });
  }
  if (!Number.isFinite(spend) || spend < 0) {
    return NextResponse.json({ error: 'spend debe ser un número ≥ 0' }, { status: 400 });
  }

  const row = {
    week_start,
    channel,
    spend,
    campaign: body.campaign ? String(body.campaign).slice(0, 200) : null,
    clicks: Number.isFinite(Number(body.clicks)) ? Math.trunc(Number(body.clicks)) : null,
    impressions: Number.isFinite(Number(body.impressions)) ? Math.trunc(Number(body.impressions)) : null,
    currency: body.currency ? String(body.currency).slice(0, 8) : 'USD',
    note: body.note ? String(body.note).slice(0, 500) : null,
  };

  const sb = createServiceClient();
  const { data, error } = await sb.from('ad_spend').insert(row).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'falta id' }, { status: 400 });
  const sb = createServiceClient();
  const { error } = await sb.from('ad_spend').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
