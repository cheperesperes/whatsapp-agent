import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient, loadAgentCatalog } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import type { AgentProduct } from '@/lib/types';
import {
  buildCatalogRef,
  extractPrices,
  extractSkuCandidates,
  matchesAnyReference,
} from '@/lib/hallucination';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Hallucination sampling cron.
//
// What & why: Sol quotes SKUs and prices from the live catalog. When the
// model hallucinates (invents a SKU that doesn't exist, or quotes a price
// that's $50 off the catalog), the customer gets bad info and the business
// eats the gap. Prior sprints added schema-level guards (price templates,
// image-tag enforcement) but no ground-truth audit. This cron samples recent
// assistant messages, extracts SKUs + prices, and flags anything that
// doesn't line up with the catalog.
//
// Signals we flag:
//   • unknown_sku   — message contains a SKU-shaped token that is not in
//                     agent_product_catalog (case-insensitive).
//   • price_mismatch — SKU exists in catalog, but the quoted $-amount is
//                     >2% away from every legitimate reference price
//                     (effective USA, effective Cuba total, Cuba
//                     delivery-only, or pre-discount original). With all
//                     four on the allow list we tolerate Sol quoting any
//                     of the line items we show her.
//
// Safety:
//   • Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron adds this).
//   • Kill switch: env `HALLUCINATION_CHECK_ENABLED=false` → 503.
//   • Dry-run: `?dry=1` returns results without sending the operator alert.
//   • Quiet mode: `?quiet=1` runs the audit but suppresses the alert (useful
//     for ad-hoc re-checks without spamming the operator).
//   • Sample cap: `HALLUCINATION_CHECK_SAMPLE_SIZE` (default 20) keeps the
//     per-run workload predictable.
//
// Intentional non-goals:
//   • We do NOT try to "fix" flagged messages or retract anything. This is
//     an audit loop — the operator decides whether a flag is real (prompt
//     tweak, catalog fix, or false positive) and adjusts manually.
//   • We do NOT run an LLM judge. Pure regex + catalog lookup: cheap,
//     deterministic, no second hallucination layer on top of the first.
// ─────────────────────────────────────────────────────────────────────────────

// ── config ──────────────────────────────────────────────────────────────────

const SAMPLE_POOL_HOURS = 24;         // look back 24h
const SAMPLE_POOL_MAX = 200;          // pool we draw the random sample from
const DEFAULT_SAMPLE_SIZE = 20;

// ── types ───────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'assistant';
  content: string;
  created_at: string;
}

type FlagKind = 'unknown_sku' | 'price_mismatch';

interface Flag {
  kind: FlagKind;
  message_id: string;
  conversation_id: string;
  created_at: string;
  sku: string;
  /** For price_mismatch: the quoted $-amounts we saw. */
  quoted_prices?: number[];
  /** For price_mismatch: what we expected. */
  expected_prices?: { usa: number; cuba_total: number; cuba_delivery: number; original?: number };
  detail?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

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
 * Fisher–Yates shuffle. Returns a new array — does not mutate input.
 * Used to randomise the sample so we don't always audit the same tail of
 * the day; Math.random is fine here (no security property needed).
 */
function shuffle<T>(input: T[]): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Truncate for the operator digest so a chatty Sol doesn't dominate the alert. */
function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// ── handler ─────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled =
    (process.env.HALLUCINATION_CHECK_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'HALLUCINATION_CHECK_ENABLED=false' },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const quiet = url.searchParams.get('quiet') === '1';
  const sampleSize = Math.max(
    1,
    Math.min(envNumber('HALLUCINATION_CHECK_SAMPLE_SIZE', DEFAULT_SAMPLE_SIZE), 100)
  );

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  // Pull the candidate pool: last 24h of assistant messages, newest first.
  // We over-fetch (up to SAMPLE_POOL_MAX) so randomisation has headroom.
  const lookback = new Date(Date.now() - SAMPLE_POOL_HOURS * 60 * 60 * 1000).toISOString();
  const { data: poolRows, error: loadErr } = await supabase
    .from('messages')
    .select('id, conversation_id, role, content, created_at')
    .eq('role', 'assistant')
    .gte('created_at', lookback)
    .order('created_at', { ascending: false })
    .limit(SAMPLE_POOL_MAX);

  if (loadErr) {
    return NextResponse.json(
      { error: `messages read failed: ${loadErr.message}`, run_id: runId },
      { status: 500 }
    );
  }

  const pool = (poolRows ?? []) as MessageRow[];
  const sample = shuffle(pool).slice(0, sampleSize);

  let catalog: AgentProduct[] = [];
  try {
    catalog = await loadAgentCatalog();
  } catch (err) {
    return NextResponse.json(
      {
        error: `catalog load failed: ${err instanceof Error ? err.message : String(err)}`,
        run_id: runId,
      },
      { status: 500 }
    );
  }
  const catalogRef = buildCatalogRef(catalog);

  // ── Scan ────────────────────────────────────────────────────────────────
  const flags: Flag[] = [];

  for (const msg of sample) {
    const skuCandidates = extractSkuCandidates(msg.content);
    if (skuCandidates.size === 0) continue;

    const prices = extractPrices(msg.content);

    for (const sku of skuCandidates) {
      const ref = catalogRef.get(sku);
      if (!ref) {
        flags.push({
          kind: 'unknown_sku',
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          created_at: msg.created_at,
          sku,
          detail: 'SKU not found in agent_product_catalog',
        });
        continue;
      }
      // If the message quotes prices at all, require at least one to match.
      // If none match → flag. (Zero-price messages aren't price-checked.)
      if (prices.length === 0) continue;
      const anyMatches = prices.some((p) => matchesAnyReference(p, ref));
      if (!anyMatches) {
        flags.push({
          kind: 'price_mismatch',
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          created_at: msg.created_at,
          sku: ref.sku,
          quoted_prices: prices,
          expected_prices: {
            usa: Math.round(ref.effectiveUsa * 100) / 100,
            cuba_total: Math.round(ref.effectiveCubaTotal * 100) / 100,
            cuba_delivery: Math.round(ref.cubaDelivery * 100) / 100,
            original: ref.original ?? undefined,
          },
        });
      }
    }
  }

  const unknownSkuCount = flags.filter((f) => f.kind === 'unknown_sku').length;
  const priceMismatchCount = flags.filter((f) => f.kind === 'price_mismatch').length;
  const distinctMessages = new Set(flags.map((f) => f.message_id)).size;

  // ── Operator alert ──────────────────────────────────────────────────────
  // Only alert when we have something to say AND we're not in dry/quiet.
  // Keep the body short — the dashboard (TBD) can show the full detail.
  const operatorPhone = process.env.OPERATOR_PHONE;
  let alertSent = false;

  if (!dryRun && !quiet && flags.length > 0 && operatorPhone) {
    try {
      const header =
        `🔎 *Auditoría de alucinaciones*\n` +
        `Muestras: ${sample.length} de ${pool.length} (últimas ${SAMPLE_POOL_HOURS}h).\n` +
        `Banderas: ${flags.length} (SKU desconocido: ${unknownSkuCount}, precio dudoso: ${priceMismatchCount}) en ${distinctMessages} mensaje${distinctMessages === 1 ? '' : 's'}.`;

      const topLines = flags.slice(0, 5).map((f) => {
        if (f.kind === 'unknown_sku') {
          return `• SKU desconocido \`${f.sku}\` (msg ${f.message_id.slice(0, 8)})`;
        }
        const expected = f.expected_prices;
        const quoted = (f.quoted_prices ?? []).map((n) => `$${n.toFixed(0)}`).join(', ');
        return (
          `• \`${f.sku}\` cotizó ${quoted || '—'} — esperado USA $${expected?.usa.toFixed(0)} / Cuba $${expected?.cuba_total.toFixed(0)}`
        );
      });
      const more = flags.length > 5 ? `\n…y ${flags.length - 5} más.` : '';

      await sendWhatsAppMessage(operatorPhone, `${header}\n${topLines.join('\n')}${more}`);
      alertSent = true;
    } catch (err) {
      console.warn('[hallucination-check] alert failed:', err instanceof Error ? err.message : err);
    }
  }

  const summary = {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    quiet,
    duration_ms: Date.now() - startedAt,
    pool_size: pool.length,
    sample_size: sample.length,
    flags_total: flags.length,
    unknown_sku: unknownSkuCount,
    price_mismatch: priceMismatchCount,
    distinct_flagged_messages: distinctMessages,
    catalog_sku_count: catalogRef.size,
    alert_sent: alertSent,
    // Full flag detail is verbose — include only when there's something to see.
    flags: flags.length > 0
      ? flags.slice(0, 50).map((f) => ({
          ...f,
          // Redact the raw content from the JSON response (PII-adjacent) but
          // include a short snippet so the operator has something to grep.
          snippet: truncate(
            (sample.find((m) => m.id === f.message_id)?.content ?? '').replace(/\s+/g, ' ').trim(),
            140
          ),
        }))
      : undefined,
  };

  console.log(
    `[hallucination-check] run=${runId} sample=${sample.length}/${pool.length} ` +
      `flags=${flags.length} (unknown=${unknownSkuCount} price=${priceMismatchCount}) ` +
      `alert=${alertSent} dry=${dryRun}`
  );

  return NextResponse.json(summary, { status: 200 });
}
