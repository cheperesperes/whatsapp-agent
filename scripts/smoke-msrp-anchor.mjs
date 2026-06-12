/**
 * Smoke test for the MSRP-anchored offer presentation.
 * Run: node scripts/smoke-msrp-anchor.mjs
 *
 * Mirrors the per-line decision in lib/supabase.ts formatOffersForPrompt: when a
 * real MSRP anchor exists (original_price > final), present ~MSRP~ *final* + the
 * TOTAL % off; otherwise fall back to coupon-only framing. Keep in lockstep with
 * that function. This is the fix for the Maddog chat where a 59%-off E3600 was
 * framed as a puny "$50 off".
 */

function anchor(msrp, finalPrice) {
  const showAnchor = msrp > finalPrice + 0.01;
  if (!showAnchor) return { showAnchor: false };
  const totalPct = Math.min(80, Math.round((1 - finalPrice / msrp) * 100));
  const totalSavings = Math.round((msrp - finalPrice) * 100) / 100;
  return { showAnchor: true, totalPct, totalSavings };
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

// E3600: $949 final vs $2,299 MSRP — the Maddog case. Must read ~59% off, not "$50".
check('E3600 ($2,299 → $949)', anchor(2299, 949), { showAnchor: true, totalPct: 59, totalSavings: 1350 });
// F5000: $1,899 final (after FAMILIA_F5000 $100) vs $2,999 MSRP.
check('F5000 ($2,999 → $1,899)', anchor(2999, 1899), { showAnchor: true, totalPct: 37, totalSavings: 1100 });
// No MSRP populated → coupon-only fallback (no fake anchor).
check('no MSRP (0) → fallback', anchor(0, 949), { showAnchor: false });
// MSRP not above final (stale/equal) → fallback, never a 0%/negative anchor.
check('MSRP ≤ final → fallback', anchor(900, 949), { showAnchor: false });
check('MSRP == final → fallback', anchor(949, 949), { showAnchor: false });
// Sanity guard caps the shown % at 80 even with an absurd MSRP.
check('absurd MSRP caps at 80%', anchor(100000, 949), { showAnchor: true, totalPct: 80, totalSavings: 99051 });

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILED`}`);
if (failures > 0) process.exit(1);
