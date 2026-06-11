import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Operator CRUD for the ad URL → product map (ad_url_map). Session-protected by
// middleware (not in PUBLIC_PATHS). Sol's webhook uses this to resolve the ad
// product when Meta's CTWA referral lacks a headline.

export async function GET() {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from('ad_url_map')
    .select('id, ad_url, sku, product_name, active, updated_at')
    .order('updated_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  let body: { ad_url?: string; sku?: string; product_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const ad_url = (body.ad_url ?? '').trim();
  const sku = ((body.sku ?? '').trim().toUpperCase()) || null;
  const product_name = (body.product_name ?? '').trim() || null;

  if (!/^https?:\/\/.+/i.test(ad_url)) {
    return NextResponse.json({ error: 'ad_url debe ser una URL (https://…)' }, { status: 400 });
  }
  if (!sku && !product_name) {
    return NextResponse.json({ error: 'indica el SKU del producto' }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from('ad_url_map')
    .upsert(
      { ad_url, sku, product_name, active: true, updated_at: new Date().toISOString() },
      { onConflict: 'ad_url' }
    )
    .select('id, ad_url, sku, product_name, active, updated_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, row: data });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = createServiceClient();
  const { error } = await sb.from('ad_url_map').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
