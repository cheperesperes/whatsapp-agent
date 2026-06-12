import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, loadAgentCatalog } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Catalog price-drift watchdog (read-only).
//
// Why: Sol quotes from `agent_product_catalog`, NOT the storefront `products`
// table. The storefront can run a sale (products.price drops) while the agent
// catalog stays stale — so Sol quotes a price the customer can't get at
// checkout (real incident 2026-06-11: Sol quoted E2000 $581 while the store +
// PECRON charge $599). The standing catalog audit only checks `products`, so it
// passes clean while Sol is wrong. This cron closes that gap.
//
// What it does: once a day, compare what Sol WOULD quote (the agent formatter's
// `sell_price × (1 − min(discount,50)/100)`) against `products.price` for every
// in-stock SKU. On any mismatch, WhatsApp-ping the operator with the list.
//
// 🚫 NEVER writes a price column — that's the absolute never-change-prices rule.
// This is DETECT + ALERT only. The fix is a deliberate, Ed-authorized sync run
// of the oiikon-catalog-audit skill (Phase 2.5). One alert per drift-set per day
// (app_config marker), so it nudges daily until resolved without spamming.
// ─────────────────────────────────────────────────────────────────────────────

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get('dry') === '1';
  const supabase = createServiceClient();

  // What Sol quotes vs what the storefront charges.
  const [agent, prodRes] = await Promise.all([
    loadAgentCatalog(),
    supabase.from('products').select('sku, price'),
  ]);
  const storePrice = new Map<string, number>(
    (prodRes.data ?? [])
      .filter((p): p is { sku: string; price: number | string } => p.sku != null && p.price != null)
      .map((p) => [p.sku, Number(p.price)])
  );

  const drift: Array<{ sku: string; sol: number; store: number }> = [];
  for (const a of agent) {
    if (!a.in_stock) continue; // only what Sol actively sells
    const store = storePrice.get(a.sku);
    if (store == null) continue; // agent-only SKU (e.g. an accessory) — skip
    const disc = Math.max(0, Math.min(50, a.discount_percentage ?? 0));
    const solShows = Math.round(a.sell_price * (1 - disc / 100) * 100) / 100;
    if (Math.abs(solShows - store) > 0.01) {
      drift.push({ sku: a.sku, sol: solShows, store });
    }
  }
  drift.sort((x, y) => Math.abs(y.sol - y.store) - Math.abs(x.sol - x.store));

  if (drift.length === 0) {
    console.log('[catalog-drift] in sync — 0 mismatches');
    return NextResponse.json({ ok: true, drift: 0 });
  }

  // One alert per unique drift-set per day (date in the signature → a persisting
  // drift re-nudges once daily; a changed set alerts immediately).
  const today = new Date().toISOString().slice(0, 10);
  const sig = `${today}:${drift.map((d) => d.sku).sort().join(',')}`;
  const { data: marker } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'catalog_drift_alert_last')
    .maybeSingle();
  const already = marker?.value === sig;

  const list = drift
    .slice(0, 15)
    .map((d) => `• ${d.sku}: Sol $${d.sol.toFixed(2)} vs tienda $${d.store.toFixed(2)}`)
    .join('\n');
  const more = drift.length > 15 ? `\n…y ${drift.length - 15} más.` : '';
  const msg =
    `⚠️ *Catálogo de Sol desincronizado* — ${drift.length} equipo(s) en stock que Sol cotiza distinto al precio de la web:\n${list}${more}\n\n` +
    `Sol está dando precios que no coinciden con el checkout. Pídeme *"sync catalog"* para alinearlos (requiere tu OK por la regla de precios).`;

  let alerted = false;
  if (!dryRun && !already) {
    try {
      await sendWhatsAppMessage(OPERATOR_PHONE, msg);
      await supabase
        .from('app_config')
        .upsert({ key: 'catalog_drift_alert_last', value: sig }, { onConflict: 'key' });
      alerted = true;
    } catch (e) {
      console.warn('[catalog-drift] operator alert failed:', e);
    }
  }

  console.log(`[catalog-drift] ${drift.length} mismatch(es) alerted=${alerted} dry=${dryRun}`);
  return NextResponse.json({ ok: true, drift: drift.length, alerted, details: drift });
}
