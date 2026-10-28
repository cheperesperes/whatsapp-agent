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
const CONFIG_KEY = 'pecron_map_audit_last';

// Every brand we resell that publishes a public Shopify feed. `match` is the
// ilike pattern on products.brand; `feed` the brand's /products.json.
const BRANDS: Array<{ name: string; match: string; feed: string }> = [
  { name: 'PECRON', match: '%pecron%', feed: process.env.PECRON_FEED_URL ?? 'https://www.pecron.com/products.json' },
  { name: 'ECO-WORTHY', match: '%eco%worthy%', feed: process.env.ECOWORTHY_FEED_URL ?? 'https://www.eco-worthy.com/products.json' },
  { name: 'SunGold Power', match: '%sungold%', feed: process.env.SUNGOLD_FEED_URL ?? 'https://sungoldpower.com/products.json' },
];
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
  brand_name: string;
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

async function fetchBrandFeed(feedUrl: string): Promise<Map<string, BrandSku>> {
  const out = new Map<string, BrandSku>();
  for (let page = 1; page <= 8; page++) {
    const res = await fetch(`${feedUrl}?limit=250&page=${page}`, {
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

  const findings: Finding[] = [];
  const notCarried: Array<{ brand: string; sku: string; product: string; price: number; handle: string }> = [];
  const perBrand: Array<{ brand: string; brand_skus: number; ours: number; matched: number; error?: string }> = [];

  for (const B of BRANDS) {
    let brand: Map<string, BrandSku>;
    try {
      brand = await fetchBrandFeed(B.feed);
    } catch (err) {
      console.error(`[map-audit] ${B.name} feed failed:`, err);
      perBrand.push({ brand: B.name, brand_skus: 0, ours: 0, matched: 0, error: String(err) });
      continue;
    }

    const { data: ours, error } = await sb
      .from('products')
      .select('sku, name, brand, price, original_price, availability_status, is_active, category')
      .eq('is_active', true)
      .ilike('brand', B.match);
    if (error) {
      perBrand.push({ brand: B.name, brand_skus: brand.size, ours: 0, matched: 0, error: error.message });
      continue;
    }

    // Fallback index: model tokens found in brand SKUs / titles (ECO-WORTHY uses
    // internal numeric SKUs on our side, SunGold spells variants differently).
    const byToken = new Map<string, BrandSku>();
    for (const b of brand.values()) {
      const tokens = new Set<string>(
        `${b.sku} ${b.product} ${b.variant}`
          .toUpperCase()
          .split(/[^A-Z0-9.]+/)
          .filter((t) => t.length >= 5 && /\d/.test(t))
      );
      for (const t of tokens) if (!byToken.has(t)) byToken.set(t, b);
    }
    const findBrand = (sku: string, name: string): BrandSku | undefined => {
      const direct = brand.get(sku);
      if (direct) return direct;
      if (byToken.has(sku)) return byToken.get(sku);
      // Model number inside our product name, e.g. "… SPH5048P - Inversor …"
      for (const t of name.toUpperCase().split(/[^A-Z0-9.]+/)) {
        if (t.length >= 5 && /\d/.test(t) && /[A-Z]/.test(t) && byToken.has(t)) return byToken.get(t);
      }
      return undefined;
    };

    const matched = new Set<string>();
    for (const p of ours ?? []) {
      const sku = norm(p.sku as string);
      if (!sku) continue;
      if (String(p.category ?? '') === 'bundle' || /^BUNDLE-/.test(sku) || /X2$/.test(sku) || /^EW-AIO-/.test(sku)) continue;
      const name = String(p.name ?? sku).slice(0, 60);
      const b = findBrand(sku, String(p.name ?? ''));
      if (!b) {
        findings.push({ brand_name: B.name, sku, name, issue: 'not_on_brand', ours: `$${Number(p.price).toFixed(2)}`, brand: '—' });
        continue;
      }
      matched.add(b.sku);
      const our = Number(p.price);
      const diff = Math.round((our - b.price) * 100) / 100;
      if (our < b.price - PRICE_TOLERANCE) {
        findings.push({ brand_name: B.name, sku, name, issue: 'below_map', ours: `$${our.toFixed(2)}`, brand: `$${b.price.toFixed(2)} (${b.sku})`, diff });
      } else if (our > b.price + PRICE_TOLERANCE) {
        findings.push({ brand_name: B.name, sku, name, issue: 'above_map', ours: `$${our.toFixed(2)}`, brand: `$${b.price.toFixed(2)} (${b.sku})`, diff });
      }
      const ourAnchor = p.original_price != null ? Number(p.original_price) : null;
      if (b.compare_at != null && ourAnchor != null && Math.abs(ourAnchor - b.compare_at) > PRICE_TOLERANCE) {
        findings.push({ brand_name: B.name, sku, name, issue: 'anchor_off', ours: `antes $${ourAnchor.toFixed(2)}`, brand: `list $${b.compare_at.toFixed(2)}` });
      }
      const ourInStock = p.availability_status === 'in_stock';
      if (ourInStock !== b.available) {
        findings.push({ brand_name: B.name, sku, name, issue: 'stock_diff', ours: String(p.availability_status ?? '—'), brand: b.available ? 'in stock' : 'sold out' });
      }
    }

    // Only PECRON's "not carried" list is actionable (their accessories fit the
    // units we sell); the other brands have hundreds of unrelated SKUs.
    if (B.name === 'PECRON') {
      const bases = [...matched];
      for (const b of brand.values()) {
        if (matched.has(b.sku) || /[*+]/.test(b.sku) || !b.available) continue;
        if (bases.some((base) => b.sku.startsWith(base + '-'))) continue;
        notCarried.push({ brand: B.name, sku: b.sku, product: b.product, price: b.price, handle: b.handle });
        if (notCarried.length >= 40) break;
      }
    }
    perBrand.push({ brand: B.name, brand_skus: brand.size, ours: (ours ?? []).length, matched: matched.size });
  }

  const report = {
    ran_at: new Date().toISOString(),
    brands: perBrand,
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
    .map((f) => `${f.brand_name}:${f.sku}:${f.issue}:${f.ours}:${f.brand}`)
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
      `• ${f.brand_name} ${f.sku} ${f.issue === 'below_map' ? '⬇️ bajo MAP' : f.issue === 'above_map' ? '⬆️ sobre MAP' : f.issue === 'anchor_off' ? '〰️ "antes" distinto' : f.issue === 'stock_diff' ? '📦 stock distinto' : '❓ no está en pecron.com'}: nosotros ${f.ours} · marca ${f.brand}`;
    const top = findings
      .sort((a, b) => (a.issue === 'below_map' ? -1 : 1) - (b.issue === 'below_map' ? -1 : 1))
      .slice(0, 14)
      .map(line);
    const text = [
      `🏷️ Auditoría de precios vs sitios de marca (${report.ran_at.slice(0, 10)}) — ${perBrand.map((b) => `${b.brand}: ${b.matched}/${b.ours}`).join(' · ')}`,
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
