/**
 * Smoke test for the competitor stale-data filter.
 * Covers:
 *   • isStale — manual override trumps age, missing last_refreshed_at is
 *     treated as stale, age comparison respects the cutoff.
 *
 * Run from repo root: npx tsx scripts/smoke-competitors-stale.ts
 * Exits 0 on success, 1 on any failure.
 */
import { COMPETITOR_STALE_DAYS, isStale } from '../lib/competitors';
import type { CompetitorModel } from '../lib/types';

let passes = 0;
let fails = 0;

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  fails += 1;
}

function makeRow(overrides: Partial<CompetitorModel>): CompetitorModel {
  return {
    id: 'id',
    brand: 'EcoFlow',
    model: 'DELTA 2',
    capacity_wh: 1024,
    inverter_watts: 1800,
    current_price_usd: 899,
    chemistry: 'LFP',
    warranty_years: 5,
    source_url: 'https://example.com',
    active: true,
    notes: null,
    manually_overridden_at: null,
    last_refreshed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 3, 21, 12, 0, 0); // April 21, 2026 12:00 UTC
const cutoffMs = NOW - COMPETITOR_STALE_DAYS * 24 * 60 * 60 * 1000;

// COMPETITOR_STALE_DAYS is the contract surface
check('COMPETITOR_STALE_DAYS === 14', COMPETITOR_STALE_DAYS, 14);

// Freshly refreshed → not stale
check(
  'refreshed 1 day ago → NOT stale',
  isStale(
    makeRow({ last_refreshed_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString() }),
    cutoffMs
  ),
  false
);

// 13 days ago → not stale (under cutoff)
check(
  'refreshed 13 days ago → NOT stale',
  isStale(
    makeRow({ last_refreshed_at: new Date(NOW - 13 * 24 * 60 * 60 * 1000).toISOString() }),
    cutoffMs
  ),
  false
);

// 14 days ago (exactly at cutoff) → NOT stale (strict <)
check(
  'refreshed 14 days ago (exact cutoff) → NOT stale (strict <)',
  isStale(
    makeRow({ last_refreshed_at: new Date(cutoffMs).toISOString() }),
    cutoffMs
  ),
  false
);

// 15 days ago → stale
check(
  'refreshed 15 days ago → stale',
  isStale(
    makeRow({ last_refreshed_at: new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString() }),
    cutoffMs
  ),
  true
);

// 30 days ago → stale
check(
  'refreshed 30 days ago → stale',
  isStale(
    makeRow({ last_refreshed_at: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString() }),
    cutoffMs
  ),
  true
);

// Null last_refreshed_at → stale (never refreshed)
check(
  'last_refreshed_at=null → stale',
  isStale(makeRow({ last_refreshed_at: null }), cutoffMs),
  true
);

// Manual override trumps age: very old but manually-overridden → NOT stale
check(
  'manual override trumps 60-day-old refresh',
  isStale(
    makeRow({
      last_refreshed_at: new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString(),
      manually_overridden_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    cutoffMs
  ),
  false
);

// Manual override + null last_refreshed_at → NOT stale
check(
  'manual override with null last_refreshed_at → NOT stale',
  isStale(
    makeRow({
      last_refreshed_at: null,
      manually_overridden_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    cutoffMs
  ),
  false
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
