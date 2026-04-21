/**
 * Smoke test for the hallucination-check helpers.
 * Covers:
 *   • buildCatalogRef — derives effective USA / Cuba-total / delivery-only
 *     prices from a discounted catalog row.
 *   • extractSkuCandidates — pulls SEND_IMAGE tags AND inline uppercase
 *     SKU-shaped tokens; excludes stopwords.
 *   • extractPrices — handles `$123`, `$1,234.50`, ignores sub-floor noise.
 *   • matchesAnyReference — ±2% window, matches against USA/Cuba/delivery/
 *     original.
 *
 * Run from repo root: npx tsx scripts/smoke-hallucination.ts
 * Exits 0 on success, 1 on any failure.
 */
import {
  buildCatalogRef,
  extractPrices,
  extractSkuCandidates,
  matchesAnyReference,
  PRICE_FLOOR_USD,
  PRICE_TOLERANCE_PCT,
} from '../lib/hallucination';
import type { AgentProduct } from '../lib/types';

let passes = 0;
let fails = 0;

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  console.log(dim('    want: ' + JSON.stringify(want)));
  console.log(dim('    got:  ' + JSON.stringify(got)));
  fails += 1;
}

function checkTrue(name: string, got: boolean) {
  check(name, got, true);
}

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

// Minimal AgentProduct factory — only the fields buildCatalogRef reads.
function makeProduct(overrides: Partial<AgentProduct>): AgentProduct {
  return {
    id: overrides.id ?? 'id',
    product_id: null,
    sku: overrides.sku ?? 'SKU',
    name: overrides.name ?? 'Test Product',
    category: overrides.category ?? 'kit',
    brand: 'PECRON',
    sell_price: overrides.sell_price ?? 469,
    cuba_shipping_fee: overrides.cuba_shipping_fee ?? 60,
    cuba_handling_fee: overrides.cuba_handling_fee ?? 20,
    cuba_total_price:
      (overrides.sell_price ?? 469) +
      (overrides.cuba_shipping_fee ?? 60) +
      (overrides.cuba_handling_fee ?? 20),
    usa_shipping_fee: 0,
    battery_capacity_ah: null,
    battery_capacity_wh: null,
    battery_voltage: null,
    battery_type: null,
    inverter_watts: null,
    inverter_type: null,
    mppt_channels: null,
    solar_input_watts: null,
    panel_watts: null,
    panel_type: null,
    output_watts: null,
    peak_watts: null,
    weight_lbs: 10,
    in_stock: true,
    stock_quantity: 5,
    description_short: null,
    ideal_for: null,
    compatible_with: null,
    supports_external_battery: false,
    original_price: overrides.original_price ?? null,
    discount_percentage: overrides.discount_percentage ?? 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// buildCatalogRef
// ────────────────────────────────────────────────────────────

console.log('buildCatalogRef:');

const refNoDiscount = buildCatalogRef([
  makeProduct({ sku: 'E500LFP', sell_price: 299, cuba_shipping_fee: 55, cuba_handling_fee: 15 }),
]);
check('no-discount effective USA == sell_price', refNoDiscount.get('E500LFP')?.effectiveUsa, 299);
check('no-discount cuba_total == sell + delivery', refNoDiscount.get('E500LFP')?.effectiveCubaTotal, 299 + 70);
check('no-discount cubaDelivery', refNoDiscount.get('E500LFP')?.cubaDelivery, 70);
check('no-discount original is null', refNoDiscount.get('E500LFP')?.original, null);

const refWithDiscount = buildCatalogRef([
  makeProduct({
    sku: 'E1500LFP',
    sell_price: 469,
    cuba_shipping_fee: 60,
    cuba_handling_fee: 20,
    original_price: 549,
    discount_percentage: 10,
  }),
]);
const refE1500 = refWithDiscount.get('E1500LFP');
check('10% discount: effective USA = sell * 0.9', refE1500?.effectiveUsa, 469 * 0.9);
check('10% discount: effective Cuba = effUsa + delivery', refE1500?.effectiveCubaTotal, 469 * 0.9 + 80);
check('discount: original preserved', refE1500?.original, 549);

// Keyed upper-cased regardless of input case
const refMixedCase = buildCatalogRef([makeProduct({ sku: 'e3600lfp', sell_price: 1000 })]);
checkTrue('keyed upper-case', refMixedCase.has('E3600LFP') && !refMixedCase.has('e3600lfp'));
check('canonical sku preserved', refMixedCase.get('E3600LFP')?.sku, 'e3600lfp');

// Out-of-range discount gets clamped to [0, 50]
const refClamp = buildCatalogRef([
  makeProduct({ sku: 'BADDISCOUNT', sell_price: 1000, discount_percentage: 999 }),
]);
check('discount clamped to 50%', refClamp.get('BADDISCOUNT')?.effectiveUsa, 500);

const refNegative = buildCatalogRef([
  makeProduct({ sku: 'NEGDISC', sell_price: 1000, discount_percentage: -5 }),
]);
check('negative discount clamped to 0%', refNegative.get('NEGDISC')?.effectiveUsa, 1000);

// Empty SKU is skipped (no throw, no entry)
const refEmptySku = buildCatalogRef([makeProduct({ sku: '', sell_price: 100 })]);
check('empty SKU skipped (map size 0)', refEmptySku.size, 0);

// ────────────────────────────────────────────────────────────
// extractSkuCandidates
// ────────────────────────────────────────────────────────────

console.log('\nextractSkuCandidates:');

function asSorted(set: Set<string>): string[] {
  return [...set].sort();
}

check(
  'SEND_IMAGE tag extracted',
  asSorted(extractSkuCandidates('Mira esta: [SEND_IMAGE:E1500LFP]')),
  ['E1500LFP']
);

check(
  'multiple SEND_IMAGE tags',
  asSorted(
    extractSkuCandidates(
      'Opciones: [SEND_IMAGE:E500LFP]\n[SEND_IMAGE:E1500LFP]\n[SEND_IMAGE:E3600LFP]'
    )
  ),
  ['E1500LFP', 'E3600LFP', 'E500LFP']
);

check(
  'inline uppercase SKU pulled in',
  asSorted(extractSkuCandidates('La E1500LFP te sirve.')),
  ['E1500LFP']
);

check(
  'SEND_IMAGE + inline (deduped)',
  asSorted(
    extractSkuCandidates('La E1500LFP es ideal. [SEND_IMAGE:E1500LFP]')
  ),
  ['E1500LFP']
);

// Tokens with `-` / `.` / `/` in SKUs
check(
  'compound SKU L13SR48100BV3.0-1 survives',
  asSorted(extractSkuCandidates('Batería L13SR48100BV3.0-1 perfecta.')),
  ['L13SR48100BV3.0-1']
);

// Stopwords skipped — WHATSAPP, OIIKON, etc. are uppercase but not SKUs.
// (Note: most stopwords are pure letters so the digit-requirement drops
// them anyway — stopwords are belt-and-braces for AC110V-type codes.)
const stopwordInput =
  'Escríbenos por WHATSAPP a OIIKON. Es un PECRON AC110V de alta calidad.';
const stopOut = extractSkuCandidates(stopwordInput);
checkTrue('WHATSAPP not flagged as SKU', !stopOut.has('WHATSAPP'));
checkTrue('OIIKON not flagged as SKU', !stopOut.has('OIIKON'));
checkTrue('PECRON not flagged as SKU', !stopOut.has('PECRON'));
checkTrue('AC110V not flagged as SKU (stopword)', !stopOut.has('AC110V'));

// Digit requirement drops pure-letter uppercase words
checkTrue(
  '"AGENTE" (no digit) is never a SKU',
  !extractSkuCandidates('Habla con nuestro AGENTE oficial.').has('AGENTE')
);

// Lowercase tokens never match (real SKU quoting is always upper)
checkTrue(
  'lowercase e1500lfp is NOT extracted',
  extractSkuCandidates('tengo un e1500lfp').size === 0
);

// ────────────────────────────────────────────────────────────
// extractPrices
// ────────────────────────────────────────────────────────────

console.log('\nextractPrices:');

check('simple $N', extractPrices('cuesta $469'), [469]);
check('decimal $N.XX', extractPrices('cuesta $469.50'), [469.5]);
check('thousands $1,234', extractPrices('serían $1,234'), [1234]);
check('thousands with decimals $1,234.50', extractPrices('serían $1,234.50'), [1234.5]);

check(
  'multiple prices in one message',
  extractPrices('USA $469 · Cuba $549 entregado (envío $80)'),
  [469, 549, 80]
);

check(
  `drops anything below PRICE_FLOOR_USD (=${PRICE_FLOOR_USD})`,
  extractPrices('$5 shipping mention, $24 small item, $25 edge, $100 real'),
  [25, 100]
);

check('no $ → empty array', extractPrices('no prices here'), []);

// Whitespace tolerance
check('$ 123 with space', extractPrices('paga $ 123 en pesos'), [123]);

// ────────────────────────────────────────────────────────────
// matchesAnyReference — ±2% window
// ────────────────────────────────────────────────────────────

console.log('\nmatchesAnyReference:');

const ref = buildCatalogRef([
  makeProduct({
    sku: 'E1500LFP',
    sell_price: 469,
    cuba_shipping_fee: 60,
    cuba_handling_fee: 20,
    original_price: 549,
    discount_percentage: 10,
  }),
])
  .get('E1500LFP')!;

// effectiveUsa = 469 * 0.9 = 422.1
// cubaDelivery = 80
// effectiveCubaTotal = 422.1 + 80 = 502.1
// original = 549

// Note the ±2% window is inclusive; we test just inside / just outside
// instead of exactly ±2% to avoid IEEE-754 boundary noise.
checkTrue('exact effective USA matches', matchesAnyReference(422.1, ref));
checkTrue('effective USA +1% matches', matchesAnyReference(422.1 * 1.01, ref));
checkTrue('effective USA +1.9% matches (just inside)', matchesAnyReference(422.1 * 1.019, ref));
checkTrue('effective USA -1.9% matches (just inside)', matchesAnyReference(422.1 * 0.981, ref));
checkTrue('effective USA +3% does NOT match', !matchesAnyReference(422.1 * 1.03, ref));
checkTrue('effective USA -3% does NOT match', !matchesAnyReference(422.1 * 0.97, ref));

checkTrue('effective Cuba total matches', matchesAnyReference(502.1, ref));
checkTrue('cubaDelivery matches', matchesAnyReference(80, ref));
checkTrue('original price matches', matchesAnyReference(549, ref));

checkTrue(
  'far-off price does NOT match any reference',
  !matchesAnyReference(250, ref) && !matchesAnyReference(999, ref)
);

// Sanity: ref with no discount has no `original`, so original-price check
// doesn't false-positive.
const refNoDisc = buildCatalogRef([
  makeProduct({ sku: 'CLEAN', sell_price: 400, cuba_shipping_fee: 50, cuba_handling_fee: 10 }),
]).get('CLEAN')!;
checkTrue('exact USA matches (no-discount)', matchesAnyReference(400, refNoDisc));
checkTrue('exact Cuba matches (no-discount)', matchesAnyReference(460, refNoDisc));
checkTrue('delivery matches (no-discount)', matchesAnyReference(60, refNoDisc));

// Custom tolerance pass-through
checkTrue(
  'custom tolerance: 10% matches with 10% tolerance',
  matchesAnyReference(400 * 1.09, refNoDisc, 10)
);
checkTrue(
  `custom tolerance: 10% does NOT match default (${PRICE_TOLERANCE_PCT}%)`,
  !matchesAnyReference(400 * 1.09, refNoDisc)
);

// ────────────────────────────────────────────────────────────
// End-to-end smoke: simulate a real Sol reply
// ────────────────────────────────────────────────────────────

console.log('\nend-to-end smoke:');

const catalog = [
  makeProduct({ sku: 'E500LFP', sell_price: 299, cuba_shipping_fee: 50, cuba_handling_fee: 20 }),
  makeProduct({
    sku: 'E1500LFP',
    sell_price: 469,
    cuba_shipping_fee: 60,
    cuba_handling_fee: 20,
    original_price: 549,
    discount_percentage: 10,
  }),
];
const catRef = buildCatalogRef(catalog);

// A well-formed reply: correct SKU, both prices match.
const goodReply =
  '💡 PECRON E1500LFP (1500Wh)\n' +
  '🇺🇸 USA $422.10 · 🇨🇺 Cuba $502.10 entregado (envío+aduana $80)\n' +
  '👉 https://oiikon.com/product/e1500lfp\n' +
  '[SEND_IMAGE:E1500LFP]';
const goodSkus = extractSkuCandidates(goodReply);
const goodPrices = extractPrices(goodReply);
checkTrue('good reply: single SKU', goodSkus.size === 1 && goodSkus.has('E1500LFP'));
checkTrue('good reply: 3 prices extracted', goodPrices.length === 3);
const goodRef = catRef.get('E1500LFP')!;
checkTrue(
  'good reply: every price matches some reference',
  goodPrices.every((p) => matchesAnyReference(p, goodRef))
);

// A hallucinated reply: invented SKU + wrong price.
const badReply =
  'La E9999MEGA te sirve, cuesta $123 USA y $200 Cuba entregado.\n' +
  '[SEND_IMAGE:E9999MEGA]';
const badSkus = extractSkuCandidates(badReply);
checkTrue('bad reply: invented SKU extracted', badSkus.has('E9999MEGA'));
checkTrue('bad reply: SKU not in catalog', !catRef.has('E9999MEGA'));

// A half-wrong reply: real SKU, wrong price.
const wrongPriceReply =
  'La E1500LFP te sale en $350 USA.';
const wpSkus = extractSkuCandidates(wrongPriceReply);
const wpPrices = extractPrices(wrongPriceReply);
const wpRef = catRef.get('E1500LFP')!;
checkTrue('wrong-price: SKU is valid', wpSkus.has('E1500LFP') && !!wpRef);
checkTrue(
  'wrong-price: $350 matches no reference (422 / 502 / 80 / 549)',
  !wpPrices.some((p) => matchesAnyReference(p, wpRef))
);

// ────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
