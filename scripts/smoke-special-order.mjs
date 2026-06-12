/**
 * Smoke test for the special-order availability logic.
 * Run: node scripts/smoke-special-order.mjs
 *
 * Self-contained (no app imports → plain node). Mirrors the two decisions the
 * feature changed, which MUST stay identical to:
 *   • lib/supabase.ts formatProductCatalogForPrompt → the OOS tag selection
 *   • lib/validate-reply.ts → which OOS SKUs join the paragraph-drop block set
 * Both key off the same SPECIAL_ORDER_CATEGORIES set. If you change either in
 * the app, change it here too.
 */

const SPECIAL_ORDER_CATEGORIES = new Set(['inverter', 'battery', 'sistemas-solares-todo-en-uno']);
const DISCONTINUED_SKUS = new Set(['E1000LFP', 'E1500LFP', 'F1000LFP']);

// Mirror of formatProductCatalogForPrompt's oosTag branch.
function oosTag(in_stock, category) {
  if (in_stock) return 'IN_STOCK';
  return SPECIAL_ORDER_CATEGORIES.has(category) ? 'POR_ENCARGO' : 'AGOTADO';
}

// Mirror of validate-reply.ts: does this catalog row join the OOS block set
// (whose pitch-paragraphs get dropped)? Discontinued always blocked; special-
// order categories exempt when OOS; everything else OOS is blocked.
function isBlockedOos(sku, in_stock, category) {
  if (DISCONTINUED_SKUS.has(sku.toUpperCase())) return true;
  return in_stock === false && !SPECIAL_ORDER_CATEGORIES.has(category);
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

// ── Tag selection ────────────────────────────────────────────────────────────
console.log('— OOS tag —');
check('OOS all-in-one (TITAN 10K) → POR ENCARGO', oosTag(false, 'sistemas-solares-todo-en-uno'), 'POR_ENCARGO');
check('OOS inverter → POR ENCARGO', oosTag(false, 'inverter'), 'POR_ENCARGO');
check('OOS 48V battery → POR ENCARGO', oosTag(false, 'battery'), 'POR_ENCARGO');
check('OOS portable (kit) → AGOTADO', oosTag(false, 'kit'), 'AGOTADO');
check('OOS panel → AGOTADO (not special-order)', oosTag(false, 'panel'), 'AGOTADO');
check('in-stock inverter → no tag', oosTag(true, 'inverter'), 'IN_STOCK');

// ── Validator block-set membership ───────────────────────────────────────────
console.log('\n— validator OOS block set —');
check('OOS all-in-one NOT blocked (consult allowed)', isBlockedOos('SUNPAL-10K-1', false, 'sistemas-solares-todo-en-uno'), false);
check('OOS inverter NOT blocked', isBlockedOos('SPH8048P', false, 'inverter'), false);
check('OOS battery NOT blocked', isBlockedOos('SG48200T', false, 'battery'), false);
check('OOS portable kit BLOCKED', isBlockedOos('F3000LFP', false, 'kit'), true);
check('discontinued E1000LFP BLOCKED even if recategorized', isBlockedOos('E1000LFP', false, 'inverter'), true);
check('in-stock special-order item NOT blocked', isBlockedOos('SPH6548P', true, 'inverter'), false);
check('in-stock portable NOT blocked', isBlockedOos('E2000LFP', true, 'kit'), false);

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILED`}`);
if (failures > 0) process.exit(1);
