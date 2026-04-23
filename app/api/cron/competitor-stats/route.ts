import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Competitor Stats Aggregator
//
// Recomputes the `competitor_stats` table from raw `competitor_mentions`
// entries in the last 30 days. For each (product_sku, competitor_name) pair
// with ≥2 price mentions, computes median/min/max and upserts the stat row.
//
// Also calls purge_old_competitor_mentions() to enforce 180-day retention.
//
// Sol reads from competitor_stats (bounded, pre-computed) — never from the
// raw mentions (unbounded, noisy).
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const sb = createServiceClient();

  // Pull mentions from the last 30 days. Older signal is too stale to guide
  // live competitor-objection pivots.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await sb
    .from('competitor_mentions')
    .select('product_sku, competitor_name, mentioned_price_usd, mentioned_at')
    .gte('mentioned_at', since)
    .not('product_sku', 'is', null)
    .not('mentioned_price_usd', 'is', null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  type Row = { product_sku: string; competitor_name: string; mentioned_price_usd: number; mentioned_at: string };
  const buckets = new Map<string, { prices: number[]; last: string }>();
  for (const r of (rows ?? []) as Row[]) {
    const key = `${r.product_sku}::${r.competitor_name}`;
    const b = buckets.get(key);
    const price = Number(r.mentioned_price_usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (b) {
      b.prices.push(price);
      if (r.mentioned_at > b.last) b.last = r.mentioned_at;
    } else {
      buckets.set(key, { prices: [price], last: r.mentioned_at });
    }
  }

  const upserts: Array<{
    product_sku: string;
    competitor_name: string;
    sample_size: number;
    median_price_usd: number | null;
    min_price_usd: number;
    max_price_usd: number;
    last_mentioned_at: string;
    recomputed_at: string;
  }> = [];

  for (const [key, { prices, last }] of buckets.entries()) {
    if (prices.length < 2) continue; // too noisy to publish
    const [product_sku, competitor_name] = key.split('::');
    upserts.push({
      product_sku,
      competitor_name,
      sample_size: prices.length,
      median_price_usd: median(prices),
      min_price_usd: Math.min(...prices),
      max_price_usd: Math.max(...prices),
      last_mentioned_at: last,
      recomputed_at: new Date().toISOString(),
    });
  }

  // Truncate + rewrite. Simpler than reconciling deletes for (sku,
  // competitor) pairs whose count dropped below the threshold this run.
  await sb.from('competitor_stats').delete().gte('recomputed_at', '1970-01-01');
  let inserted = 0;
  if (upserts.length > 0) {
    const { error: insErr, count } = await sb
      .from('competitor_stats')
      .insert(upserts, { count: 'exact' });
    if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
    inserted = count ?? upserts.length;
  }

  // Enforce 180-day retention on raw mentions.
  let purged = 0;
  const { data: purgeData } = await sb.rpc('purge_old_competitor_mentions');
  if (typeof purgeData === 'number') purged = purgeData;

  return NextResponse.json({
    ok: true,
    scanned_mentions: rows?.length ?? 0,
    buckets: buckets.size,
    published_stats: inserted,
    purged_old_mentions: purged,
    duration_ms: Date.now() - startedAt,
  });
}
