import { createServiceClient } from './supabase';
import type { AgentProduct, CompetitorModel } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Competitor pitch — the data + helpers Sol uses to pivot respectfully when a
// customer mentions another brand. The frame is *apples-to-apples on $/Wh*:
// match by capacity, then show that PECRON delivers the same energy for less.
//
// Source of truth: `competitor_models` table. Refreshed weekly by
// /api/cron/refresh-competitors.
// ─────────────────────────────────────────────────────────────────────────────

const PECRON_BRAND_RE = /pecron/i;

/** Load active competitor rows for prompt injection / dashboard listing. */
export async function loadCompetitorModels(opts: { activeOnly?: boolean } = {}): Promise<CompetitorModel[]> {
  const supabase = createServiceClient();
  let query = supabase
    .from('competitor_models')
    .select('*')
    .order('brand')
    .order('capacity_wh');
  if (opts.activeOnly !== false) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) {
    console.error('[competitors] load failed:', error.message);
    return [];
  }
  return (data ?? []) as CompetitorModel[];
}

/** $/Wh — the metric the whole pitch hangs on. */
export function dollarsPerWh(priceUsd: number, capacityWh: number): number {
  if (!capacityWh || capacityWh <= 0) return 0;
  return priceUsd / capacityWh;
}

/**
 * Find the closest PECRON match for a competitor by capacity.
 * Prefers the smallest PECRON whose Wh meets or exceeds the competitor's Wh
 * (so we can honestly say "same or more energy"). Falls back to the absolute
 * closest if no PECRON is large enough.
 *
 * Only considers in-stock PECRON kits/all-in-one units — comparing a
 * competitor power station to a bare battery would be misleading.
 */
export function findPecronMatchByCapacity(
  competitor: CompetitorModel,
  catalog: AgentProduct[]
): AgentProduct | null {
  const candidates = catalog.filter((p) => {
    if (!PECRON_BRAND_RE.test(p.brand ?? '')) return false;
    if (p.in_stock === false) return false;
    // Only kits / all-in-one stations have a meaningful Wh-vs-EcoFlow comparison.
    const isKit =
      p.category === 'kit' ||
      p.category === 'portable_station' ||
      p.category === 'all_in_one' ||
      p.category === 'sistemas-solares-todo-en-uno';
    if (!isKit) return false;
    return (p.battery_capacity_wh ?? 0) > 0;
  });
  if (candidates.length === 0) return null;

  // First try: smallest PECRON ≥ competitor capacity ("same or more energy")
  const equalOrLarger = candidates
    .filter((p) => (p.battery_capacity_wh ?? 0) >= competitor.capacity_wh)
    .sort((a, b) => (a.battery_capacity_wh ?? 0) - (b.battery_capacity_wh ?? 0));
  if (equalOrLarger[0]) return equalOrLarger[0];

  // Fallback: absolute closest by Wh distance
  return candidates
    .map((p) => ({
      p,
      dist: Math.abs((p.battery_capacity_wh ?? 0) - competitor.capacity_wh),
    }))
    .sort((a, b) => a.dist - b.dist)[0]?.p ?? null;
}

/**
 * Apply the active discount (if any) to a PECRON sell_price so $/Wh is
 * computed on the price the customer would actually pay.
 */
export function effectivePecronPrice(p: AgentProduct): number {
  const discount = p.discount_percentage ?? 0;
  return discount > 0 ? p.sell_price * (1 - discount / 100) : p.sell_price;
}

/**
 * Build the catalog-comparison block injected into Sol's system prompt.
 * Only includes the competitors with a PECRON match — anything we can't
 * pair off would just confuse the comparison.
 */
export function formatCompetitorsForPrompt(
  competitors: CompetitorModel[],
  catalog: AgentProduct[]
): string {
  if (competitors.length === 0) return '';

  const rows: string[] = [];
  for (const c of competitors) {
    const match = findPecronMatchByCapacity(c, catalog);
    if (!match) continue;
    const compRate = dollarsPerWh(c.current_price_usd, c.capacity_wh);
    const pecPrice = effectivePecronPrice(match);
    const pecRate = dollarsPerWh(pecPrice, match.battery_capacity_wh ?? 1);
    const savingsPct = compRate > 0 ? Math.round(((compRate - pecRate) / compRate) * 100) : 0;

    rows.push(
      `• ${c.brand} ${c.model}: ${c.capacity_wh.toLocaleString()} Wh, $${c.current_price_usd.toFixed(0)} → $${compRate.toFixed(2)}/Wh ` +
        `↔ PECRON ${match.sku}: ${(match.battery_capacity_wh ?? 0).toLocaleString()} Wh, $${pecPrice.toFixed(0)} → $${pecRate.toFixed(2)}/Wh ` +
        `(${savingsPct > 0 ? `-${savingsPct}% por Wh` : 'paridad'})`
    );
  }

  if (rows.length === 0) return '';

  return [
    '',
    '=== COMPARATIVA DE COMPETIDORES — $/Wh (apples-to-apples) ===',
    'Cuando el cliente mencione una marca de la lista de abajo, valida la marca con respeto y pivota a $/Wh contra el PECRON más cercano por capacidad.',
    'Nunca trash-talkees. La frase ancla es: *"misma energía almacenada, menos costo por Wh"*.',
    'Datos verificados; refresh automático semanal:',
    ...rows,
  ].join('\n');
}
