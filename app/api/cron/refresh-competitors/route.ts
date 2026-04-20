import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import type { CompetitorModel } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Competitor price auto-refresh.
//
// For each active competitor_models row (oldest last_refreshed_at first),
// fetch its `source_url`, ask Haiku to extract the current selling price,
// diff against stored value, write back + audit.
//
// Why this design:
//   • Per-row fetch (not per-brand-collection): brand collection pages
//     hide prices behind JS or sales modals; product pages always show
//     the live price. More reliable, more granular.
//   • Process oldest-N per run: caps cost + runtime. Daily cron =
//     ~2-3 days for full coverage of 35 rows; plenty fresh for prices
//     that move weekly at most.
//   • Same safety guards as inventory sync: auth, kill switch, mass-flip
//     guard, override TTL, dry-run, audit log.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ROWS_PER_RUN = 15;            // cap to fit Vercel's 30s function budget
const FETCH_CONCURRENCY = 3;            // be polite to vendor sites
const FETCH_TIMEOUT_MS = 8_000;         // per-row HTML fetch
const EXTRACT_TIMEOUT_MS = 6_000;       // per-row Haiku call
const PRICE_CHANGE_EPSILON_PCT = 0.5;   // ignore <0.5% drift (rounding noise)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

interface PriceChange {
  row: CompetitorModel;
  oldPrice: number;
  newPrice: number;
  changePct: number;
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fetch a vendor page as HTML. Truncates to 80kb so we don't blow Haiku's
 * context window on bloated marketing pages.
 */
async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some sites 403 a bare default user-agent.
        'user-agent':
          'Mozilla/5.0 (compatible; OiikonSolBot/1.0; +https://oiikon.com)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 80_000);
  } catch (err) {
    console.warn(`[refresh-competitors] fetch failed ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Ask Haiku to read the page and return ONLY the current selling price.
 * Returns null on failure (caller treats as "skip this row").
 */
async function extractCurrentPrice(html: string, brand: string, model: string): Promise<number | null> {
  const prompt = `You are extracting the current SELLING price from a product page.

Brand: ${brand}
Model: ${model}

Rules:
- Return the price the customer would actually pay TODAY (the discounted/sale price if visible, NOT the MSRP/strikethrough).
- USD only.
- If the price is not visible or you are unsure, return null.
- Return ONLY a JSON object: {"price_usd": number | null}. No explanation.

Page HTML (truncated):
${html}

Return ONLY the JSON.`;

  try {
    const res = await anthropic.messages.create(
      {
        model: EXTRACT_MODEL,
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: EXTRACT_TIMEOUT_MS }
    );
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as { price_usd: number | null };
    if (parsed.price_usd === null || parsed.price_usd === undefined) return null;
    const n = Number(parsed.price_usd);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.warn(`[refresh-competitors] extract failed ${brand} ${model}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Process rows in concurrency-limited batches. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled = (process.env.COMPETITOR_REFRESH_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'COMPETITOR_REFRESH_ENABLED=false' },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const limit = Math.max(1, Math.min(envNumber('COMPETITOR_REFRESH_BATCH', MAX_ROWS_PER_RUN), 50));
  const overrideTtlHours = envNumber('COMPETITOR_REFRESH_OVERRIDE_TTL_HOURS', 24 * 7); // 7d
  const maxFlipPct = envNumber('COMPETITOR_REFRESH_MAX_FLIP_PCT', 50); // bigger window than inventory; sale swings happen

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  // Pull active rows with a source_url, oldest first. Skip rows whose
  // operator-edit override is still fresh.
  const overrideCutoff = new Date(Date.now() - overrideTtlHours * 60 * 60 * 1000).toISOString();
  const { data: rows, error: loadErr } = await supabase
    .from('competitor_models')
    .select('*')
    .eq('active', true)
    .not('source_url', 'is', null)
    .or(`manually_overridden_at.is.null,manually_overridden_at.lt.${overrideCutoff}`)
    .order('last_refreshed_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (loadErr) {
    return NextResponse.json({ error: `load failed: ${loadErr.message}` }, { status: 500 });
  }

  const candidates = (rows ?? []) as CompetitorModel[];

  // Fetch + extract concurrently
  type Outcome =
    | { kind: 'change'; change: PriceChange }
    | { kind: 'noop'; row: CompetitorModel; price: number }
    | { kind: 'skip'; row: CompetitorModel; reason: string };

  const outcomes: Outcome[] = await mapWithLimit(candidates, FETCH_CONCURRENCY, async (row) => {
    if (!row.source_url) return { kind: 'skip', row, reason: 'no source_url' };
    const html = await fetchPageHtml(row.source_url);
    if (!html) return { kind: 'skip', row, reason: 'fetch failed' };
    const newPrice = await extractCurrentPrice(html, row.brand, row.model);
    if (newPrice === null) return { kind: 'skip', row, reason: 'extract failed' };
    const oldPrice = row.current_price_usd;
    const changePct = oldPrice > 0 ? Math.abs(newPrice - oldPrice) / oldPrice * 100 : 100;
    if (changePct < PRICE_CHANGE_EPSILON_PCT) {
      return { kind: 'noop', row, price: newPrice };
    }
    return { kind: 'change', change: { row, oldPrice, newPrice, changePct } };
  });

  const changes = outcomes
    .filter((o): o is Extract<Outcome, { kind: 'change' }> => o.kind === 'change')
    .map((o) => o.change);
  const noops = outcomes.filter((o) => o.kind === 'noop');
  const skipped = outcomes.filter((o) => o.kind === 'skip');

  const flipPct = candidates.length > 0 ? (changes.length / candidates.length) * 100 : 0;

  const summary = {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    duration_ms: 0,
    candidates: candidates.length,
    changed: changes.length,
    unchanged: noops.length,
    skipped: skipped.length,
    flip_pct: Math.round(flipPct * 10) / 10,
    aborted: false as boolean,
    abort_reason: null as string | null,
  };

  // Mass-flip guard: if more than X% of candidates would change AND we have a
  // meaningful sample, abort. Catches "every brand had a flash sale" or, more
  // likely, a parsing regression that thinks every page now reads $1.
  if (candidates.length >= 5 && flipPct > maxFlipPct) {
    summary.aborted = true;
    summary.abort_reason = `flip ratio ${flipPct.toFixed(1)}% > limit ${maxFlipPct}%`;
    const operatorPhone = process.env.OPERATOR_PHONE;
    if (operatorPhone && !dryRun) {
      sendWhatsAppMessage(
        operatorPhone,
        `⚠️ *Competitor refresh ABORTED*\n${summary.abort_reason}.\n${changes.length} of ${candidates.length} models would have changed price — rejected as suspicious.`
      ).catch((e) => console.warn('[refresh-competitors] alert failed:', e));
    }
    summary.duration_ms = Date.now() - startedAt;
    return NextResponse.json(summary, { status: 409 });
  }

  if (dryRun) {
    summary.duration_ms = Date.now() - startedAt;
    return NextResponse.json(
      {
        ...summary,
        changes_preview: changes.slice(0, 20).map((c) => ({
          brand: c.row.brand,
          model: c.row.model,
          old: c.oldPrice,
          new: c.newPrice,
          change_pct: Math.round(c.changePct * 10) / 10,
        })),
        skipped_preview: skipped.slice(0, 10).map((s) => ({
          brand: s.row.brand,
          model: s.row.model,
          reason: s.reason,
        })),
      },
      { status: 200 }
    );
  }

  // Apply: update each changed row, audit-log every change, bump
  // last_refreshed_at on EVERY successful extract (changed or no-op).
  const now = new Date().toISOString();

  if (changes.length > 0) {
    // Per-row updates (no upsert needed; rows already exist).
    await Promise.all(
      changes.map((c) =>
        supabase
          .from('competitor_models')
          .update({
            current_price_usd: c.newPrice,
            last_refreshed_at: now,
            updated_at: now,
          })
          .eq('id', c.row.id)
      )
    );

    const logRows = changes.map((c) => ({
      run_id: runId,
      brand: c.row.brand,
      model: c.row.model,
      field: 'current_price_usd',
      old_value: String(c.oldPrice),
      new_value: String(c.newPrice),
      source_url: c.row.source_url,
    }));
    const { error: logErr } = await supabase.from('competitor_refresh_log').insert(logRows);
    if (logErr) console.warn('[refresh-competitors] log insert failed:', logErr.message);
  }

  // Bump last_refreshed_at for the no-ops too — we DID check them, prices
  // just didn't move. Otherwise they'd keep cycling to the front of the queue.
  if (noops.length > 0) {
    const noopIds = noops.map((o) => (o.kind === 'noop' ? o.row.id : '')).filter(Boolean);
    if (noopIds.length > 0) {
      await supabase
        .from('competitor_models')
        .update({ last_refreshed_at: now })
        .in('id', noopIds);
    }
  }

  // Best-effort summary alert (only when something actually changed)
  const operatorPhone = process.env.OPERATOR_PHONE;
  if (operatorPhone && changes.length > 0) {
    const lines = changes.slice(0, 8).map((c) => {
      const arrow = c.newPrice > c.oldPrice ? '↑' : '↓';
      return `• ${c.row.brand} ${c.row.model}: $${c.oldPrice.toFixed(0)} → *$${c.newPrice.toFixed(0)}* ${arrow}`;
    });
    const more = changes.length > 8 ? `\n…y ${changes.length - 8} más.` : '';
    sendWhatsAppMessage(
      operatorPhone,
      `📊 *Competitor refresh:* ${changes.length} precio${changes.length === 1 ? '' : 's'} actualizado${
        changes.length === 1 ? '' : 's'
      } (de ${candidates.length} revisado${candidates.length === 1 ? '' : 's'}):\n${lines.join('\n')}${more}`
    ).catch((e) => console.warn('[refresh-competitors] summary alert failed:', e));
  }

  summary.duration_ms = Date.now() - startedAt;
  return NextResponse.json(summary, { status: 200 });
}
