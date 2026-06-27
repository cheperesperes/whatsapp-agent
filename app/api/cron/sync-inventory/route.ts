import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Inventory (STOCK) sync — oiikon.com (`products`) → agent (`agent_product_catalog`)
//
// STOCK ONLY. Prices are deliberately NOT synced: the two tables hold different
// prices on purpose (anchor vs real selling price), so copying prices across
// would reconcile them — a HARD-RULE violation. Marketing reads the live
// storefront price directly at post time. This route only keeps `in_stock` /
// `stock_quantity` current so the agent never recommends a sold-out product.
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
//   • Override TTL: rows with `manually_overridden_at` newer than
//     INVENTORY_SYNC_OVERRIDE_TTL_HOURS (default 24) are skipped, so a
//     deliberate operator change isn't silently reverted.
//   • Dry-run: pass `?dry=1` to compute the diff and return it without
//     writing anything.
// ─────────────────────────────────────────────────────────────────────────────

// STOCK ONLY — never sync price columns. The storefront `products` and the
// agent `agent_product_catalog` hold DIFFERENT prices ON PURPOSE (anchor vs
// real selling price); syncing prices would reconcile them, which is a HARD-RULE
// violation (see memory feedback_never_change_store_prices). Marketing reads the
// live storefront price directly at post time instead. Removing price fields
// here also means the discount-spike guard never fires, so no more spike alerts.
const SYNCED_FIELDS = [
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
  is_active?: boolean | null;
  is_publicly_visible?: boolean | null;
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

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  // Heartbeat — record every authorized invocation so the cron's liveness is
  // observable, independent of whether there were changes to apply. This is how
  // we tell "Vercel isn't firing the cron" apart from "nothing to sync".
  {
    const { error: hbErr } = await supabase.from('app_config').upsert(
      { key: 'inventory_sync_last_invoked', value: new Date(startedAt).toISOString() },
      { onConflict: 'key' }
    );
    if (hbErr) console.warn('[sync-inventory] heartbeat failed:', hbErr.message);
  }

  // ── Load both sides (only the columns we actually sync, plus join key) ──
  // NO is_active filter: we need inactive/hidden products too, so Sol stops
  // selling a product the moment Ed deactivates or hides it on the website.
  // (Previously inactive products vanished from this read and their agent rows
  // were "left alone" — i.e. they kept selling in Sol forever. Found 2026-06-10:
  // 5 deactivated products still marked sellable in the agent catalog.)
  const { data: websiteRows, error: webErr } = await supabase
    .from('products')
    .select('sku, sell_price, original_price, discount_percentage, in_stock, stock_quantity, is_active, is_publicly_visible')
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

  // Keyed case-insensitively — a SKU casing drift between the two tables must
  // never silently break the match.
  const websiteBySku = new Map<string, WebsiteRow>();
  for (const r of (websiteRows ?? []) as WebsiteRow[]) {
    if (r.sku) websiteBySku.set(r.sku.toUpperCase(), r);
  }
  const agentBySku = new Map<string, AgentRow>();
  for (const r of (agentRows ?? []) as AgentRow[]) {
    if (r.sku) agentBySku.set(r.sku.toUpperCase(), r);
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

    // Effective availability: Sol may only sell a product whose website row
    // EXISTS, is active, publicly visible AND in stock. Deleted, deactivated
    // or hidden products count as out of stock. The mass-flip guard below
    // still protects against an accidental bulk delete/deactivation upstream.
    const sellable =
      !!web && !!web.in_stock && web.is_active !== false && web.is_publicly_visible !== false &&
      // A TRACKED quantity of 0 is not sellable even if in_stock=true (catches
      // "coming soon"/phantom rows where in_stock was never cleared). A null
      // quantity = untracked → fall back to the in_stock flag.
      (web.stock_quantity == null || web.stock_quantity > 0);
    const effective: Record<SyncedField, unknown> = {
      in_stock: sellable,
      stock_quantity: sellable ? web?.stock_quantity ?? 0 : 0,
    };

    const fieldChanges: FieldChange[] = [];
    for (const field of SYNCED_FIELDS) {
      const oldV = (agent as unknown as Record<string, unknown>)[field];
      const newV = effective[field];
      if (valuesDiffer(field, oldV, newV)) {
        fieldChanges.push({ sku: agent.sku ?? sku, field, oldValue: oldV ?? null, newValue: newV ?? null });
      }
    }

    if (fieldChanges.length > 0) {
      changesBySku.set(sku, fieldChanges);
      const stockChange = fieldChanges.find((c) => c.field === 'in_stock');
      // Alert on any transition INTO out-of-stock — incl. NULL→false (a
      // never-initialized row going OOS), not just true→false.
      if (stockChange && stockChange.oldValue !== false && stockChange.newValue === false) {
        oosTransitions.push({ sku, name: agent.name });
      }
    }
  }

  // ── Catalog parity: sellable website products Sol doesn't know about ──
  // We never auto-insert them (a new agent row needs Ed's price decision —
  // automation NEVER writes prices), so we report + alert instead.
  const missingInAgent: string[] = [];
  for (const [key, web] of websiteBySku.entries()) {
    if (
      web.in_stock &&
      web.is_active !== false &&
      web.is_publicly_visible !== false &&
      !agentBySku.has(key)
    ) {
      missingInAgent.push(web.sku);
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
    missing_in_agent: missingInAgent.length,
    missing_in_agent_skus: missingInAgent.slice(0, 20),
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

  // (Discount-spike guard removed — prices are no longer synced; the agent
  // reads live storefront prices directly at post time. See SYNCED_FIELDS note.)

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
    // UPDATE existing rows by sku — never upsert. `.upsert({onConflict:'sku'})`
    // failed to match the existing row and attempted an INSERT (new id, no
    // `name` → NOT-NULL violation → 500), so the cron fired every 10 min for
    // months but never applied a single change. The cron only ever touches rows
    // that ALREADY exist (new website products are reported via missingInAgent,
    // never auto-inserted), so a plain per-sku UPDATE is correct and cannot
    // create duplicates. cs[0].sku carries the row's original casing.
    const now = new Date().toISOString();
    for (const cs of changesBySku.values()) {
      const patch: Record<string, unknown> = { updated_at: now };
      for (const c of cs) patch[c.field] = c.newValue;
      const { error: updErr } = await supabase
        .from('agent_product_catalog')
        .update(patch)
        .eq('sku', cs[0].sku);
      if (updErr) {
        // Surface the error where we can see it (Vercel cron logs aren't
        // reachable) so a future failure is diagnosable, not silent.
        await supabase.from('app_config').upsert(
          { key: 'inventory_sync_last_error', value: `update ${cs[0].sku}: ${updErr.message}`.slice(0, 500) },
          { onConflict: 'key' }
        );
        return NextResponse.json(
          { error: `update failed (${cs[0].sku}): ${updErr.message}`, summary },
          { status: 500 }
        );
      }
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

  // ── Missing-SKU alert — once a day, durable ──
  // The old gate was "the 12:0x UTC run" by wall clock: a delayed or skipped
  // run silently lost the whole day's alert, and a same-window retry could
  // double-send. Now ANY run at/after 12:00 UTC sends IF the app_config
  // marker says today's alert hasn't gone out yet (marker set before the
  // send so concurrent runs can't double-fire).
  const nowUtc = new Date();
  const todayUtc = nowUtc.toISOString().slice(0, 10);
  if (operatorPhone && missingInAgent.length > 0 && nowUtc.getUTCHours() >= 12) {
    const { data: marker } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'sol_missing_sku_alert_last_sent')
      .maybeSingle();
    if ((marker?.value ?? '') !== todayUtc) {
      const { error: markErr } = await supabase
        .from('app_config')
        .upsert({ key: 'sol_missing_sku_alert_last_sent', value: todayUtc }, { onConflict: 'key' });
      if (markErr) {
        console.warn('[sync-inventory] missing-sku alert marker failed (skipping alert):', markErr.message);
      } else {
        const list = missingInAgent.slice(0, 12).map((s) => `• ${s}`).join('\n');
        sendWhatsAppMessage(
          operatorPhone,
          `🛒 *Catálogo de Sol:* ${missingInAgent.length} producto(s) vendibles en oiikon.com que Sol NO tiene (no los puede ofrecer ni cobrar):\n${list}\n\nAgrégalos a agent_product_catalog con su precio para que Sol los venda.`
        ).catch((e) => console.warn('[sync-inventory] missing-sku alert failed:', e));
      }
    }
  }

  summary.duration_ms = Date.now() - startedAt;
  return NextResponse.json(summary, { status: 200 });
}
