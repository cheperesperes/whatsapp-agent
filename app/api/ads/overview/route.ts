import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Ad-performance breakdown for /dashboard/ads. Session-protected by middleware
// (not in PUBLIC_PATHS). Groups WhatsApp leads by the Click-to-WhatsApp ad
// creative captured in conversations.ad_source, and overlays current stock so
// the operator can SEE when an ad is funneling buyers to a sold-out product.

interface ConvRow {
  phone_number: string | null;
  ad_source: string | null;
  lead_quality: string | null;
  converted_at: string | null;
  created_at: string;
}

interface AdRow {
  product: string;
  url: string | null;
  sku: string | null;
  in_stock: boolean | null;
  leads: number;
  hot: number;
  warm_plus: number;
  conversions: number;
  conv_rate: number;
  last_lead: string;
}

const SKU_RE = /\b([EF]\d{3,4}[A-Z]{0,5})\b/;
const phoneKey = (raw: string | null | undefined) => (raw ?? '').replace(/\D/g, '').slice(-10);

export async function GET(req: NextRequest) {
  const sb = createServiceClient();
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: convData, error } = await sb
    .from('conversations')
    .select('phone_number, ad_source, lead_quality, converted_at, created_at')
    .eq('channel', 'whatsapp')
    .gte('created_at', since);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const convs = (convData ?? []) as ConvRow[];

  // Orders by phone → the EARLIEST order date for that phone. A lead only
  // counts as a conversion if an order happened AT/AFTER the lead arrived —
  // otherwise a repeat buyer who purchased months before an ad existed would
  // wrongly inflate that ad's conversion rate.
  const { data: orderData } = await sb
    .from('orders')
    .select('customer_phone, created_at')
    .not('customer_phone', 'is', null);
  const firstOrderByKey = new Map<string, string>();
  for (const o of (orderData ?? []) as Array<{ customer_phone: string; created_at: string }>) {
    const k = phoneKey(o.customer_phone);
    if (!k || !o.created_at) continue;
    const prev = firstOrderByKey.get(k);
    if (!prev || o.created_at > prev) firstOrderByKey.set(k, o.created_at); // keep latest order date
  }

  // Current stock for SKUs the ads point at. Guard null sku (the column is
  // nullable — a single null-sku row would otherwise crash the whole page).
  const { data: stockData } = await sb.from('agent_product_catalog').select('sku, in_stock');
  const stockBySku = new Map<string, boolean>();
  for (const r of (stockData ?? []) as Array<{ sku: string | null; in_stock: boolean }>) {
    if (r.sku) stockBySku.set(r.sku.toUpperCase(), r.in_stock);
  }

  // Aggregate by ad creative (ad_source = "ad | <product> | <url>").
  const adLeads = convs.filter((c) => c.ad_source);
  const organicLeads = convs.length - adLeads.length;
  const byProduct = new Map<string, { url: string | null; rows: ConvRow[] }>();
  for (const c of adLeads) {
    const parts = (c.ad_source ?? '').split(' | ');
    const product = (parts[1] ?? c.ad_source ?? 'Anuncio').trim();
    const url = parts[2]?.trim() || null;
    const entry = byProduct.get(product) ?? { url, rows: [] };
    entry.rows.push(c);
    if (!entry.url && url) entry.url = url;
    byProduct.set(product, entry);
  }

  const ads: AdRow[] = [];
  for (const [product, { url, rows }] of byProduct.entries()) {
    const sku = product.match(SKU_RE)?.[1]?.toUpperCase() ?? null;
    const converted = rows.filter((r) => {
      if (r.converted_at != null) return true;
      const orderAt = firstOrderByKey.get(phoneKey(r.phone_number));
      return orderAt != null && orderAt >= r.created_at; // order placed at/after the lead arrived
    }).length;
    ads.push({
      product,
      url,
      sku,
      in_stock: sku && stockBySku.has(sku) ? stockBySku.get(sku)! : null,
      leads: rows.length,
      hot: rows.filter((r) => r.lead_quality === 'hot').length,
      warm_plus: rows.filter((r) => r.lead_quality === 'hot' || r.lead_quality === 'warm').length,
      conversions: converted,
      conv_rate: rows.length ? Math.round((converted / rows.length) * 1000) / 10 : 0,
      last_lead: rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), rows[0].created_at),
    });
  }
  ads.sort((a, b) => b.leads - a.leads);

  return NextResponse.json({
    window_days: days,
    totals: {
      ad_leads: adLeads.length,
      organic_leads: organicLeads,
      ad_share_pct: convs.length ? Math.round((adLeads.length / convs.length) * 100) : 0,
      ads_to_oos: ads.filter((a) => a.in_stock === false).reduce((n, a) => n + a.leads, 0),
    },
    ads,
  });
}
