import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Inventory sync — oiikon.com (`products`) → agent (`agent_product_catalog`)
//
// Both apps share this Supabase project, so this is a database-internal
// upsert, not a network call to a separate platform. Vercel Cron hits this
// route every 10 minutes (see vercel.json).
//
// Safety guards (any of which short-circuits the run with no writes):
//   • Auth: requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends
//     this header automatically when CRON_SECRET is configured).
//   • Kill switch: env var `INVENTORY_SYNC_ENABLED=false` returns 503.
//   • Mass-flip guard: if more than INVENTORY_SYNC_MAX_FLIP_PCT (default 30)
//     percent of rows would change in_stock state in this single run, abort
//     and alert the operator. Catches accidental bulk-deletes on the website.
//   • Discount-spike guard: if any SKU's discount jumps by more than
//     INVENTORY_SYNC_MAX_DISCOUNT_JUMP points in a single sync (default 30),
//     OR the incoming value exceeds INVENTORY_SYNC_MAX_DISCOUNT_ABS (default
//     50%), abort. A typo turning 5% into 50% could torch margin instantly,
//     so we stop and ask for a human to confirm.
//   • Override TTL: rows with `manually_overridden_at` newer than
//     INVENTORY_SYNC_OVERRIDE_TTL_HOURS (default 24) are skipped, so a
//     deliberate operator change isn't silently reverted.
//   • Dry-run: pass `?dry=1` to compute the diff and return it without
//     writing anything.
// ─────────────────────────────────────────────────────────────────────────────

const SYNCED_FIELDS = [
  'sell_price',
  'original_price',
  'discount_percentage',
  'in_stock',
  'stock_quantity',
] as const;
type SyncedField = (typeof SYNCED_FIELDS)[number];

const OOS_ALERT_CAP = 5; // never spam the operator with more than this many OOS alerts per run

interface WebsiteRow {
  sku: string;
  sell_price: number | null;
  original_price: number | null;
  discount_percentage: number | null;
  in_stock: boolean | null;
  stock_quantity: number | null;
}

interface AgentRow extends WebsiteRow {
  manually_overridden_at: string | null;
  name: string | null;
}

interface FieldChange {
  sku: string;
  field: SyncedField;
  oldValue: unknown;
  newValue: unknown;
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured → only allow in non-production so local dev still works.
    return process.env.VERCEL_ENV !== 'production';
  }
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Equality that treats null/undefined/0 carefully and rounds floats to 4 places
 * so a Postgres numeric → JS number → numeric round-trip doesn't cause a
 * spurious "change" log on every run.
 */
function valuesDiffer(field: SyncedField, oldV: unknown, newV: unknown): boolean {
  if (field === 'in_stock') {
    return !!oldV !== !!newV;
  }
  const a = normalizeNumeric(oldV);
  const b = normalizeNumeric(newV);
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.round(a * 10000) !== Math.round(b * 10000);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled = (process.env.INVENTORY_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'INVENTORY_SYNC_ENABLED=false' },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';

  const overrideTtlHours = envNumber('INVENTORY_SYNC_OVERRIDE_TTL_HOURS', 24);
  const maxFlipPct = envNumber('INVENTORY_SYNC_MAX_FLIP_PCT', 30);
  const maxDiscountJump = envNumber('INVENTORY_SYNC_MAX_DISCOUNT_JUMP', 30);
  const maxDiscountAbs = envNumber('INVENTORY_SYNC_MAX_DISCOUNT_ABS', 50);

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  // ── Load both sides (only the columns we actually sync, plus join key) ──
  const { data: websiteRows, error: webErr } = await supabase
    .from('products')
    .select('sku, sell_price, original_price, discount_percentage, in_stock, stock_quantity')
    .eq('is_active', true)
    .not('sku', 'is', null);

  if (webErr) {
    return NextResponse.json({ error: `website read failed: ${webErr.message}` }, { status: 500 });
  }

  const { data: agentRows, error: agentErr } = await supabase
    .from('agent_product_catalog')
    .select('sku, name, sell_price, original_price, discount_percentage, in_stock, stock_quantity, manually_overridden_at');

  if (agentErr) {
    return NextResponse.json({ error: `agent read failed: ${agentErr.message}` }, { status: 500 });
  }

  const websiteBySku = new Map<string, WebsiteRow>();
  for (const r of (websiteRows ?? []) as WebsiteRow[]) {
    if (r.sku) websiteBySku.set(r.sku, r);
  }
  const agentBySku = new Map<string, AgentRow>();
  for (const r of (agentRows ?? []) as AgentRow[]) {
    if (r.sku) agentBySku.set(r.sku, r);
  }

  // ── Compute diffs (skipping protected rows) ──
  const overrideCutoff = Date.now() - overrideTtlHours * 60 * 60 * 1000;
  const skipped: string[] = [];
  const changesBySku = new Map<string, FieldChange[]>();
  const oosTransitions: Array<{ sku: string; name: string | null }> = [];

  for (const [sku, agent] of agentBySku.entries()) {
    if (
      agent.manually_overridden_at &&
      Date.parse(agent.manually_overridden_at) > overrideCutoff
    ) {
      skipped.push(sku);
      continue;
    }

    const web = websiteBySku.get(sku);
    if (!web) continue; // SKU not active on website → leave agent row alone (don't auto-deactivate)

    const fieldChanges: FieldChange[] = [];
    for (const field of SYNCED_FIELDS) {
      const oldV = (agent as unknown as Record<string, unknown>)[field];
      const newV = (web as unknown as Record<string, unknown>)[field];
      if (valuesDiffer(field, oldV, newV)) {
        fieldChanges.push({ sku, field, oldValue: oldV ?? null, newValue: newV ?? null });
      }
    }

    if (fieldChanges.length > 0) {
      changesBySku.set(sku, fieldChanges);
      const stockChange = fieldChanges.find((c) => c.field === 'in_stock');
      if (stockChange && stockChange.oldValue === true && stockChange.newValue === false) {
        oosTransitions.push({ sku, name: agent.name });
      }
    }
  }

  // ── Mass-flip safety guard ──
  const totalEligible = agentBySku.size - skipped.length;
  const flipCount = [...changesBySku.values()].filter((cs) =>
    cs.some((c) => c.field === 'in_stock')
  ).length;
  const flipPct = totalEligible > 0 ? (flipCount / totalEligible) * 100 : 0;

  const summary = {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    duration_ms: 0,
    eligible: totalEligible,
    skipped_overridden: skipped.length,
    skus_with_changes: changesBySku.size,
    field_changes: [...changesBySku.values()].reduce((n, cs) => n + cs.length, 0),
    stock_flips: flipCount,
    stock_flip_pct: Math.round(flipPct * 10) / 10,
    oos_transitions: oosTransitions.length,
    aborted: false as boolean,
    abort_reason: null as string | null,
  };

  if (flipCount > 0 && flipPct > maxFlipPct) {
    summary.aborted = true;
    summary.abort_reason = `stock-flip ratio ${flipPct.toFixed(1)}% > limit ${maxFlipPct}%`;
    // Best-effort alert — do not block the response.
    const operatorPhone = process.env.OPERATOR_PHONE;
    if (operatorPhone && !dryRun) {
      sendWhatsAppMessage(
        operatorPhone,
        `⚠️ *Inventory sync ABORTED*\n${summary.abort_reason}.\n${flipCount} of ${totalEligible} SKUs would have changed stock state — rejected as suspicious. Check the website if this was intentional, then re-run.`
      ).catch((e) => console.warn('[sync-inventory] alert failed:', e));
    }
    summary.duration_ms = Date.now() - startedAt;
    return NextResponse.json(summary, { status: 409 });
  }

  // ── Discount-spike safety guard ──
  // Collect any discount_percentage change whose jump exceeds maxDiscountJump
  // or whose target value is above maxDiscountAbs. Either is suspicious enough
  // to stop the entire run. This is the price-safety twin of the mass-flip
  // guard: the website (or a human typo) can't silently blow up margin by
  // bumping a product from 5% to 50% off.
  const discountSpikes: Array<{ sku: string; oldPct: number; newPct: number; reason: string }> = [];
  for (const [sku, cs] of changesBySku.entries()) {
    const disc = cs.find((c) => c.field === 'discount_percentage');
    if (!disc) continue;
    const oldPct = normalizeNumeric(disc.oldValue) ?? 0;
    const newPct = normalizeNumeric(disc.newValue) ?? 0;
    const jump = Math.abs(newPct - oldPct);
    if (newPct > maxDiscountAbs) {
      discountSpikes.push({ sku, oldPct, newPct, reason: `target ${newPct}% > max ${maxDiscountAbs}%` });
    } else if (jump > maxDiscountJump) {
      discountSpikes.push({ sku, oldPct, newPct, reason: `jump ${jump.toFixed(1)} pts > max ${maxDiscountJump} pts` });
    }
  }

  if (discountSpikes.length > 0) {
    summary.aborted = true;
    const head = discountSpikes.slice(0, 5);
    const preview = head.map((d) => `${d.sku}: ${d.oldPct}% → ${d.newPct}% (${d.reason})`).join('; ');
    const more = discountSpikes.length > 5 ? ` …+${discountSpikes.length - 5} más` : '';
    summary.abort_reason = `discount spike on ${discountSpikes.length} SKU(s): ${preview}${more}`;
    const operatorPhone = process.env.OPERATOR_PHONE;
    if (operatorPhone && !dryRun) {
      sendWhatsAppMessage(
        operatorPhone,
        `⚠️ *Inventory sync ABORTED — discount spike*\n${discountSpikes.length} SKU(s) tried to jump past safety caps (max ${maxDiscountAbs}% absolute, ${maxDiscountJump} pt jump). Revísalos en oiikon.com antes de re-ejecutar:\n${head.map((d) => `• ${d.sku}: ${d.oldPct}% → ${d.newPct}%`).join('\n')}${more}`
      ).catch((e) => console.warn('[sync-inventory] discount-spike alert failed:', e));
    }
    summary.duration_ms = Date.now() - startedAt;
    return NextResponse.json(summary, { status: 409 });
  }

  // ── Dry-run: return the diff without writing ──
  if (dryRun) {
    summary.duration_ms = Date.now() - startedAt;
    return NextResponse.json(
      {
        ...summary,
        changes_preview: [...changesBySku.entries()].slice(0, 20).map(([sku, cs]) => ({
          sku,
          fields: cs.map((c) => ({ field: c.field, old: c.oldValue, new: c.newValue })),
        })),
      },
      { status: 200 }
    );
  }

  // ── Apply changes (one upsert per SKU + one log batch) ──
  if (changesBySku.size > 0) {
    const upsertRows: Array<Record<string, unknown>> = [];
    for (const [sku, cs] of changesBySku.entries()) {
      const row: Record<string, unknown> = { sku };
      for (const c of cs) row[c.field] = c.newValue;
      row.updated_at = new Date().toISOString();
      upsertRows.push(row);
    }

    const { error: upsertErr } = await supabase
      .from('agent_product_catalog')
      .upsert(upsertRows, { onConflict: 'sku' });

    if (upsertErr) {
      return NextResponse.json(
        { error: `upsert failed: ${upsertErr.message}`, summary },
        { status: 500 }
      );
    }

    // Audit log — one row per (sku, field) change. Best-effort: a log
    // failure should not invalidate the sync that already succeeded.
    const logRows = [...changesBySku.values()].flat().map((c) => ({
      run_id: runId,
      sku: c.sku,
      field: c.field,
      old_value: c.oldValue === null ? null : String(c.oldValue),
      new_value: c.newValue === null ? null : String(c.newValue),
      source: 'website',
    }));
    const { error: logErr } = await supabase.from('inventory_sync_log').insert(logRows);
    if (logErr) {
      console.warn('[sync-inventory] log insert failed:', logErr.message);
    }
  }

  // ── OOS alerts (capped) ──
  const operatorPhone = process.env.OPERATOR_PHONE;
  if (operatorPhone && oosTransitions.length > 0) {
    const head = oosTransitions.slice(0, OOS_ALERT_CAP);
    const list = head.map((o) => `• ${o.sku}${o.name ? ` — ${o.name}` : ''}`).join('\n');
    const more =
      oosTransitions.length > OOS_ALERT_CAP
        ? `\n…y ${oosTransitions.length - OOS_ALERT_CAP} más.`
        : '';
    sendWhatsAppMessage(
      operatorPhone,
      `📉 *Inventario:* productos marcados como AGOTADOS en el sitio web (Sol ya no los va a recomendar):\n${list}${more}`
    ).catch((e) => console.warn('[sync-inventory] OOS alert failed:', e));
  }

  summary.duration_ms = Date.now() - startedAt;
  return NextResponse.json(summary, { status: 200 });
}
