// ─────────────────────────────────────────────────────────────────────────────
// PECRON MAP audit — our storefront vs the brand's website (read-only).
//
// pecron.com is a Shopify store; its public feed /products.json lists every
// variant with `sku`, `price` (what the brand sells at today = the MAP floor
// for dealers), `compare_at_price` (list price) and `available`.
//
// Once a week (and on demand from the dashboard) this cron:
//   1. Downloads the full feed (paged, 250/page).
//   2. Matches our active PECRON products by SKU (normalised: upper-case,
//      no spaces; a few known aliases).
//   3. Flags, per SKU:
//        below_map   — our price < brand price  → dealer-agreement risk
//        above_map   — our price > brand price  → we look expensive
//        anchor_off  — our "antes" (original_price) ≠ brand compare-at
//        stock_diff  — brand in stock while we show out-of-stock, or vice versa
//        not_on_brand— SKU no longer on pecron.com (discontinued?)
//      and lists brand SKUs we don't carry (new products).
//   4. Stores the report in app_config (key pecron_map_audit_last, JSON) and
//      WhatsApps the operator a short digest when something changed since the
//      previous run (first run always sends).
//
// 🚫 NEVER writes a price. Detect + report only. Fixing is a deliberate,
// owner-authorised change on the storefront.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';
const BRAND_FEED = process.env.PECRON_FEED_URL ?? 'https://www.pecron.com/products.json';
const CONFIG_KEY = 'pecron_map_audit_last';
const PRICE_TOLERANCE = 0.5; // dollars — ignore rounding noise

// Our SKU → brand SKU when they differ in spelling.
const SKU_ALIASES: Record<string, string> = {
  'TE-200': 'TE-200CART',
  'TE-320': 'TF-320CART',
  'TROLLEY': 'E3000TROLLEY',
  'E300LFP': 'E300LFP-1', // brand lists the bare unit as the "-1" variant
};

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

interface ShopifyVariant {
  sku: string | null;
  title: string;
  price: string;
  compare_at_price: string | null;
  available: boolean;
}
interface ShopifyProduct {
  title: string;
  handle: string;
  variants: ShopifyVariant[];
}
interface BrandSku {
  sku: string;
  product: string;
  variant: string;
  handle: string;
  price: number;
  compare_at: number | null;
  available: boolean;
}
interface Finding {
  sku: string;
  name: string;
  issue: 'below_map' | 'above_map' | 'anchor_off' | 'stock_diff' | 'not_on_brand';
  ours: string;
  brand: string;
  diff?: number;
}

function norm(sku: string | null | undefined): string {
  const s = (sku ?? '').toUpperCase().replace(/\s+/g, '').trim();
  return SKU_ALIASES[s] ?? s;
}

async function fetchBrandFeed(): Promise<Map<string, BrandSku>> {
  const out = new Map<string, BrandSku>();
  for (let page = 1; page <= 8; page++) {
    const res = await fetch(`${BRAND_FEED}?limit=250&page=${page}`, {
      headers: { 'user-agent': 'OiikonMapAudit/1.0 (+https://oiikon.com)' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`brand feed ${res.status} on page ${page}`);
    const data = (await res.json()) as { products?: ShopifyProduct[] };
    const products = data.products ?? [];
    for (const p of products) {
      for (const v of p.variants ?? []) {
        const sku = norm(v.sku);
        if (!sku) continue;
        // Single-unit variants only (bundles like "F5000LFP-PV300*2" are the
        // brand's own kits — we compare base units).
        const row: BrandSku = {
          sku,
          product: p.title,
          variant: v.title,
          handle: p.handle,
          price: Number(v.price),
          compare_at: v.compare_at_price != null ? Number(v.compare_at_price) : null,
          available: !!v.available,
        };
        if (!out.has(sku)) out.set(sku, row);
      }
    }
    if (products.length < 250) break;
  }
  return out;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const sb = createServiceClient();

  let brand: Map<string, BrandSku>;
  try {
    brand = await fetchBrandFeed();
  } catch (err) {
    console.error('[pecron-map-audit] feed failed:', err);
    return NextResponse.json({ ok: false, error: `brand feed unreachable: ${String(err)}` }, { status: 502 });
  }

  const { data: ours, error } = await sb
    .from('products')
    .select('sku, name, brand, price, original_price, availability_status, is_active, category')
    .eq('is_active', true)
    .ilike('brand', '%pecron%');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const findings: Finding[] = [];
  const matched = new Set<string>();

  for (const p of ours ?? []) {
    const sku = norm(p.sku as string);
    if (!sku) continue;
    // Our own kits (BUNDLE-*, x2 kits) have no counterpart on the brand site.
    if (String(p.category ?? '') === 'bundle' || /^BUNDLE-/.test(sku) || /X2$/.test(sku)) continue;
    const b = brand.get(sku);
    const name = String(p.name ?? sku).slice(0, 60);
    if (!b) {
      findings.push({ sku, name, issue: 'not_on_brand', ours: `$${Number(p.price).toFixed(2)}`, brand: '—' });
      continue;
    }
    matched.add(sku);
    const our = Number(p.price);
    const diff = Math.round((our - b.price) * 100) / 100;
    if (our < b.price - PRICE_TOLERANCE) {
      findings.push({ sku, name, issue: 'below_map', ours: `$${our.toFixed(2)}`, brand: `$${b.price.toFixed(2)}`, diff });
    } else if (our > b.price + PRICE_TOLERANCE) {
      findings.push({ sku, name, issue: 'above_map', ours: `$${our.toFixed(2)}`, brand: `$${b.price.toFixed(2)}`, diff });
    }
    const ourAnchor = p.original_price != null ? Number(p.original_price) : null;
    if (b.compare_at != null && ourAnchor != null && Math.abs(ourAnchor - b.compare_at) > PRICE_TOLERANCE) {
      findings.push({ sku, name, issue: 'anchor_off', ours: `antes $${ourAnchor.toFixed(2)}`, brand: `list $${b.compare_at.toFixed(2)}` });
    }
    const ourInStock = p.availability_status === 'in_stock';
    if (ourInStock !== b.available) {
      findings.push({
        sku,
        name,
        issue: 'stock_diff',
        ours: String(p.availability_status ?? '—'),
        brand: b.available ? 'in stock' : 'sold out',
      });
    }
  }

  // Brand single-unit SKUs we don't carry (skip the brand's own bundles/kits).
  const bases = [...matched];
  const notCarried = [...brand.values()]
    .filter((b) => !matched.has(b.sku) && !/[*+]/.test(b.sku) && b.available)
    // "E2400LFP-300W", "F3000LFP-PV300" are the brand's own kits of units we already carry.
    .filter((b) => !bases.some((base) => b.sku.startsWith(base + '-')))
    .map((b) => ({ sku: b.sku, product: b.product, price: b.price, handle: b.handle }))
    .slice(0, 40);

  const report = {
    ran_at: new Date().toISOString(),
    brand_skus: brand.size,
    our_pecron_skus: (ours ?? []).length,
    matched: matched.size,
    counts: {
      below_map: findings.filter((f) => f.issue === 'below_map').length,
      above_map: findings.filter((f) => f.issue === 'above_map').length,
      anchor_off: findings.filter((f) => f.issue === 'anchor_off').length,
      stock_diff: findings.filter((f) => f.issue === 'stock_diff').length,
      not_on_brand: findings.filter((f) => f.issue === 'not_on_brand').length,
      not_carried: notCarried.length,
    },
    findings,
    not_carried: notCarried,
  };

  // Digest only when the set of price/stock findings changed since last run.
  const signature = findings
    .map((f) => `${f.sku}:${f.issue}:${f.ours}:${f.brand}`)
    .sort()
    .join('|');
  const { data: prev } = await sb.from('app_config').select('value').eq('key', CONFIG_KEY).maybeSingle();
  let prevSig = '';
  try {
    prevSig = prev?.value ? (JSON.parse(String(prev.value)).signature ?? '') : '';
  } catch {
    prevSig = '';
  }
  const changed = signature !== prevSig;

  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, changed, ...report });

  await sb
    .from('app_config')
    .upsert({ key: CONFIG_KEY, value: JSON.stringify({ ...report, signature }) }, { onConflict: 'key' });

  if (changed && findings.length > 0) {
    const line = (f: Finding) =>
      `• ${f.sku} ${f.issue === 'below_map' ? '⬇️ bajo MAP' : f.issue === 'above_map' ? '⬆️ sobre MAP' : f.issue === 'anchor_off' ? '〰️ "antes" distinto' : f.issue === 'stock_diff' ? '📦 stock distinto' : '❓ no está en pecron.com'}: nosotros ${f.ours} · marca ${f.brand}`;
    const top = findings
      .sort((a, b) => (a.issue === 'below_map' ? -1 : 1) - (b.issue === 'below_map' ? -1 : 1))
      .slice(0, 14)
      .map(line);
    const text = [
      `🏷️ Auditoría de precios vs pecron.com (${report.ran_at.slice(0, 10)})`,
      `${report.counts.below_map} bajo MAP · ${report.counts.above_map} sobre MAP · ${report.counts.anchor_off} "antes" distinto · ${report.counts.stock_diff} stock distinto · ${report.counts.not_on_brand} no en marca · ${report.counts.not_carried} nuevos de la marca que no vendemos`,
      '',
      ...top,
      findings.length > 14 ? `… y ${findings.length - 14} más en el panel.` : '',
      '',
      'No se cambió ningún precio. Detalle completo: panel → Productos → Auditoría MAP.',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await sendWhatsAppMessage(OPERATOR_PHONE, text);
    } catch (err) {
      console.error('[pecron-map-audit] alert failed:', err);
    }
  }

  console.log('[pecron-map-audit]', JSON.stringify({ ...report, findings: undefined, not_carried: undefined, changed }));
  return NextResponse.json({ ok: true, changed, ...report });
}
