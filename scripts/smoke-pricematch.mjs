/**
 * Smoke test for the price-match margin floor + outcome decision logic.
 * Run: node scripts/smoke-pricematch.mjs
 *
 * Self-contained on purpose (no app imports → runs with plain node, no env / no
 * Supabase). It mirrors the EXACT formula in lib/paylink.ts:
 *   • priceMatchFloor()  = cost / (1 − M/100), or null when cost is unknown.
 *   • the inline decision in applyPriceMatchMarkers (already_cheaper/match/hold).
 * If you change either in lib/paylink.ts, change it here too — these two are the
 * guarantee that "match a competitor" never becomes a race to the bottom.
 */

const M = Number(process.env.PRICE_MATCH_MIN_MARGIN_PCT ?? 12);

function priceMatchFloor(cost) {
  if (cost == null || !(cost > 0)) return null;
  const m = Math.max(0, Math.min(45, M));
  return Math.round((cost / (1 - m / 100)) * 100) / 100;
}

function decide(ourPrice, comp, floor) {
  if (comp >= ourPrice - 0.01) return 'already_cheaper';
  if (floor != null && comp >= floor) return 'match';
  return 'hold';
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label} → got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`);
}

const floorOf = (cost) => Math.round((cost / (1 - M / 100)) * 100) / 100;

// ── Floor math ──────────────────────────────────────────────────────────────
check('floor(null) is null (no cost → cannot prove margin)', priceMatchFloor(null), null);
check('floor(undefined) is null', priceMatchFloor(undefined), null);
check('floor(0) is null', priceMatchFloor(0), null);
check('floor(-5) is null', priceMatchFloor(-5), null);
check(`floor(400) = 400/(1-${M}/100)`, priceMatchFloor(400), floorOf(400));
check('floor(700) rounds to cents', priceMatchFloor(700), floorOf(700));

// ── Outcome decisions (ourPrice = $999, cost = $500 → floor at M=12 ≈ $568.18) ─
const ourPrice = 999;
const floor = priceMatchFloor(500);
console.log(`\n(ourPrice=$${ourPrice}, cost=$500 → floor=$${floor}, margin=${M}%)`);

check('competitor ABOVE our price → already_cheaper', decide(ourPrice, 1099, floor), 'already_cheaper');
check('competitor EQUAL to our price → already_cheaper', decide(ourPrice, 999, floor), 'already_cheaper');
check('competitor between floor and ours → match', decide(ourPrice, 850, floor), 'match');
check('competitor exactly at floor → match', decide(ourPrice, floor, floor), 'match');
check('competitor a cent below floor → hold', decide(ourPrice, Math.round((floor - 0.01) * 100) / 100, floor), 'hold');
check('competitor far below floor → hold (no race to bottom)', decide(ourPrice, 300, floor), 'hold');
check('cost unknown (floor null), competitor below ours → hold', decide(ourPrice, 600, null), 'hold');
check('cost unknown, competitor above ours → already_cheaper', decide(ourPrice, 1200, null), 'already_cheaper');

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILED`}`);
if (failures > 0) process.exit(1);
