import type { AgentProduct } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Hallucination-check helpers.
//
// Pure functions extracted from the hallucination-check cron so smoke tests
// can run them without a Supabase/Vercel env. The cron calls the same
// functions — there is ONE implementation, not a copy per caller.
// ─────────────────────────────────────────────────────────────────────────────

/** ±% window a quoted price has to fall inside to count as a match. */
export const PRICE_TOLERANCE_PCT = 2;

/** Ignore any `$N` match below this — almost always not a product price. */
export const PRICE_FLOOR_USD = 25;

/**
 * Conservative SKU shape: starts with a letter, at least 4 chars total,
 * uppercase only, allows separators `-` `.` `/` between alnum groups.
 * Catches E1500LFP / L13SR48100BV3.0-1 style while ignoring normal words.
 */
export const SKU_CANDIDATE_REGEX = /\b[A-Z][A-Z0-9]{3,}(?:[-./][A-Z0-9]+)*\b/g;

/**
 * Same tag regex the webhook uses for image dispatch — keep in sync.
 * Anything inside these brackets is an unambiguous SKU assertion by Sol.
 */
export const IMAGE_TAG_REGEX = /\[SEND_IMAGE:\s*([A-Z0-9][A-Z0-9_\-./]*)\s*\]/gi;

/**
 * Price in USD. Accepts `$123`, `$123.45`, `$1,234`, `$1,234.50`.
 * The capturing group is the raw numeric string (commas preserved; we
 * strip before Number()).
 */
export const PRICE_REGEX = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{1,6}(?:\.[0-9]{1,2})?)/g;

/**
 * Words that happen to match SKU_CANDIDATE_REGEX but are clearly not SKUs.
 * Kept tiny — false positives here are fine; false negatives (a real SKU
 * silently unchecked) are the expensive mistake.
 */
export const SKU_STOPWORDS = new Set<string>([
  'WHATSAPP',
  'OIIKON',
  'PECRON',
  'HUMSIENK',
  'LFPBOSS',
  'USA',
  'ETA',
  'USD',
  'IVA',
  'SKU',
  'LFP',
  'NMC',
  'MPPT',
  'PWM',
  'DC12V',
  'AC110V',
  'AC220V',
]);

export interface CatalogRef {
  /** Canonical SKU exactly as stored in the catalog (case preserved). */
  sku: string;
  effectiveUsa: number;
  effectiveCubaTotal: number;
  cubaDelivery: number;
  original: number | null;
}

/**
 * Build the catalog reference map from raw rows. Keyed by upper-cased SKU
 * because Sol (and humans) quote SKUs in whatever case they land on.
 *
 * Callers should load the FULL catalog (not only in_stock = true) — a
 * legitimate reply might quote a SKU that went out of stock between send
 * and audit, which is still a real SKU.
 */
export function buildCatalogRef(products: AgentProduct[]): Map<string, CatalogRef> {
  const ref = new Map<string, CatalogRef>();
  for (const p of products) {
    if (!p.sku) continue;
    const rawDiscount = Number(p.discount_percentage ?? 0);
    const discount = Math.max(
      0,
      Math.min(50, Number.isFinite(rawDiscount) ? rawDiscount : 0)
    );
    const effectiveUsa =
      discount > 0 ? p.sell_price * (1 - discount / 100) : p.sell_price;
    const cubaDelivery =
      (p.cuba_shipping_fee ?? 0) + (p.cuba_handling_fee ?? 0);
    const effectiveCubaTotal = effectiveUsa + cubaDelivery;

    ref.set(p.sku.toUpperCase(), {
      sku: p.sku,
      effectiveUsa,
      effectiveCubaTotal,
      cubaDelivery,
      original: p.original_price ?? null,
    });
  }
  return ref;
}

/**
 * Extract every SKU-shaped token from a message. Returns upper-cased set.
 *
 * Pulls from two sources:
 *   1. `[SEND_IMAGE:SKU]` tags — unambiguous SKU assertion by Sol.
 *   2. Inline uppercase tokens with ≥1 digit that aren't stopwords.
 */
export function extractSkuCandidates(content: string): Set<string> {
  const out = new Set<string>();

  for (const m of content.matchAll(IMAGE_TAG_REGEX)) {
    out.add(m[1].toUpperCase());
  }

  for (const m of content.matchAll(SKU_CANDIDATE_REGEX)) {
    const tok = m[0].toUpperCase();
    if (SKU_STOPWORDS.has(tok)) continue;
    if (!/[0-9]/.test(tok)) continue;
    out.add(tok);
  }

  return out;
}

/**
 * Extract every `$N` amount from a message, returning numeric values in
 * order of appearance. Strips thousands-separator commas before parsing.
 * Drops anything below PRICE_FLOOR_USD.
 */
export function extractPrices(content: string): number[] {
  const prices: number[] = [];
  for (const m of content.matchAll(PRICE_REGEX)) {
    const raw = m[1].replace(/,/g, '');
    const n = Number(raw);
    if (Number.isFinite(n) && n >= PRICE_FLOOR_USD) prices.push(n);
  }
  return prices;
}

/** Within ±tolerance% of target? Zero-target returns false to avoid NaN. */
export function withinTolerance(
  value: number,
  target: number,
  pct: number
): boolean {
  if (target <= 0) return false;
  const drift = (Math.abs(value - target) / target) * 100;
  return drift <= pct;
}

/**
 * Does the quoted price match any legitimate reference for this catalog row?
 * Reference set: effective USA, effective Cuba total, Cuba delivery-only,
 * and (when a discount is active) the pre-discount original price.
 */
export function matchesAnyReference(
  price: number,
  ref: CatalogRef,
  tolerancePct: number = PRICE_TOLERANCE_PCT
): boolean {
  const candidates: number[] = [
    ref.effectiveUsa,
    ref.effectiveCubaTotal,
    ref.cubaDelivery,
  ];
  if (ref.original) candidates.push(ref.original);
  return candidates.some((c) => withinTolerance(price, c, tolerancePct));
}
