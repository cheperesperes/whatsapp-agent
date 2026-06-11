import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  createServiceClient,
  loadCustomerProfile,
  storeMessage,
} from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import {
  buildFollowupDraft,
  hasPriorFollowup,
  extractProductModel,
  MAX_AUTO_NUDGES,
  MIN_NUDGE_GAP_HOURS,
} from '@/lib/followup';
import { isInQuietHours, timezoneFromPhone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Auto follow-up for silent warm leads.
//
// What & why: AGENT_PROMPT.md (lines 868-882) tells Sol "the system will
// automatically send a gentle nudge 18-24h later" when a customer receives a
// full quote (price + link + photo) and goes silent. In practice, that cron
// never existed — the prompt was making a promise the backend didn't keep, and
// ~20% of warm leads that would have replied to a nudge simply got dropped on
// the floor. This route is that missing piece.
//
// Policy: exactly ONE follow-up, ever. WhatsApp Business Policy only permits
// free-form messages inside a 24-hour window from the customer's last inbound
// message. We target 18-24h to stay safely inside that window and then stop.
// A second nudge would (a) violate policy risks, (b) per Sol's own prompt
// research, cause opt-outs.
//
// Safety guards (any of which short-circuits a given conversation — or the
// whole run):
//   • Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron adds this).
//   • Kill switch: env `FOLLOWUP_CRON_ENABLED=false` returns 503.
//   • Per-run cap: `FOLLOWUP_CRON_MAX_SEND` (default 50) — prevents a buggy
//     selection query from flooding customers.
//   • Time window: strict 18-24h since last conversation event — outside that
//     range we do nothing.
//   • Must be customer-silent: last message on the conversation is Sol's, not
//     the customer's. If the customer already replied we stay out of their way.
//   • Must be a full quote: the last assistant message contains a product link
//     (`https://oiikon.com/product/…`). "Hello" alone doesn't qualify.
//   • No double-nudge: we scan recent assistant messages for our template
//     phrases ("quería ver si pudo revisar" / "just checking in on") — if any
//     exist we skip.
//   • No opt-outs, no escalated, no closed.
//   • Dry-run: `?dry=1` returns the candidate list without sending.
// ─────────────────────────────────────────────────────────────────────────────

// ── config ──────────────────────────────────────────────────────────────────

/** The 18-23h window is measured from the CUSTOMER's last inbound message
 * (that's what the WhatsApp 24h free-form policy counts). The conversations
 * prefilter below uses a wider updated_at range because a touch-1 nudge
 * (sales-followup / paylink-nudge, 2-6h) bumps updated_at without resetting
 * the policy window. */
const WINDOW_LOWER_HOURS = 18;
const WINDOW_UPPER_HOURS = 23;
const PREFILTER_LOWER_HOURS = 12;
const PREFILTER_UPPER_HOURS = 24;
const PRODUCT_LINK_RE = /https?:\/\/(?:www\.)?oiikon\.com\/product\//i;
/**
 * How many recent messages to load per candidate. 12 is plenty to detect a
 * prior followup and a quote in the tail; keeps the per-run DB load
 * predictable.
 */
const MESSAGE_TAIL = 12;

// ── helpers ─────────────────────────────────────────────────────────────────

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

type SkipReason =
  | 'no_messages'
  | 'last_not_assistant'
  | 'no_product_link'
  | 'no_user_messages'
  | 'already_followed_up'
  | 'max_nudges'
  | 'nudge_too_recent'
  | 'too_early'
  | 'window_closed'
  | 'quiet_hours'
  | 'send_failed';

interface CandidateRow {
  id: string;
  phone_number: string;
  customer_name: string | null;
  updated_at: string;
}

interface MessageRow {
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

// ── handler ─────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled =
    (process.env.FOLLOWUP_CRON_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'FOLLOWUP_CRON_ENABLED=false' },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const maxSend = envNumber('FOLLOWUP_CRON_MAX_SEND', 50);

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  const now = Date.now();
  const lowerBound = new Date(now - PREFILTER_UPPER_HOURS * 60 * 60 * 1000).toISOString(); // 24h ago
  const upperBound = new Date(now - PREFILTER_LOWER_HOURS * 60 * 60 * 1000).toISOString(); // 12h ago

  // ── Find candidate conversations ───────────────────────────────────────
  // Strict window: updated_at between 24h-ago (inclusive) and 18h-ago
  // (inclusive). Sort oldest-first so if we hit maxSend we prioritise leads
  // closest to the 24h policy wall.
  const { data: convRows, error: convErr } = await supabase
    .from('conversations')
    .select('id, phone_number, customer_name, updated_at')
    // WhatsApp-only with a real phone — web-widget conversations have
    // channel='web' and phone_number=NULL, and would otherwise reach
    // sendWhatsAppMessage(null) and throw every hourly run.
    .eq('channel', 'whatsapp')
    .not('phone_number', 'is', null)
    .eq('opted_out', false)
    .eq('escalated', false)
    .neq('status', 'closed')
    .gte('updated_at', lowerBound)
    .lte('updated_at', upperBound)
    .order('updated_at', { ascending: true })
    .limit(maxSend * 3);

  if (convErr) {
    return NextResponse.json(
      { error: `conversations read failed: ${convErr.message}`, run_id: runId },
      { status: 500 }
    );
  }

  const candidates = (convRows ?? []) as CandidateRow[];

  // Accumulators.
  const sent: Array<{
    conversation_id: string;
    phone: string;
    language: 'es' | 'en';
    preview: string;
  }> = [];
  const skipped: Array<{ conversation_id: string; reason: SkipReason; detail?: string }> = [];
  const errors: Array<{ conversation_id: string; error: string }> = [];

  for (const c of candidates) {
    if (sent.length >= maxSend) break;

    // Load the tail of messages for this conversation (newest first).
    const { data: msgRows, error: msgErr } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_TAIL);

    if (msgErr) {
      errors.push({ conversation_id: c.id, error: `messages read: ${msgErr.message}` });
      continue;
    }

    const msgs = (msgRows ?? []) as MessageRow[];
    if (msgs.length === 0) {
      skipped.push({ conversation_id: c.id, reason: 'no_messages' });
      continue;
    }

    // Last message must be Sol's — if the customer already replied, they're
    // engaged and we stay out of the way.
    const last = msgs[0];
    if (last.role !== 'assistant') {
      skipped.push({ conversation_id: c.id, reason: 'last_not_assistant' });
      continue;
    }

    // Must have been a real quote, not a greeting — a product link in ANY
    // recent assistant message. (Not just the last one: after a touch-1
    // nudge, the last assistant message is the nudge itself, but the lead
    // is still a quoted lead.)
    const quoteMsg = msgs.find((m) => m.role === 'assistant' && PRODUCT_LINK_RE.test(m.content));
    if (!quoteMsg) {
      skipped.push({ conversation_id: c.id, reason: 'no_product_link' });
      continue;
    }

    // Must have at least one user message ever — otherwise the customer has
    // never engaged and a nudge would feel like cold outreach, not a follow-up.
    const lastUser = msgs.find((m) => m.role === 'user');
    if (!lastUser) {
      skipped.push({ conversation_id: c.id, reason: 'no_user_messages' });
      continue;
    }

    // The 18-23h window is measured from the CUSTOMER's last inbound — that
    // is what the WhatsApp 24h free-form policy counts. A touch-1 nudge bumps
    // updated_at but does NOT reset this window.
    const userAgeH = (now - Date.parse(lastUser.created_at)) / (60 * 60 * 1000);
    if (userAgeH < WINDOW_LOWER_HOURS) {
      skipped.push({ conversation_id: c.id, reason: 'too_early', detail: `last inbound ${userAgeH.toFixed(1)}h` });
      continue;
    }
    if (userAgeH > WINDOW_UPPER_HOURS) {
      skipped.push({ conversation_id: c.id, reason: 'window_closed', detail: `last inbound ${userAgeH.toFixed(1)}h` });
      continue;
    }

    // ── Nudge-ladder guards (sol_followups ledger) ──────────────────────
    // Max MAX_AUTO_NUDGES automated touches per conversation, ≥
    // MIN_NUDGE_GAP_HOURS apart. Pre-ledger nudges (legacy text markers,
    // no row) can't be timed → conservative skip, preserving the old
    // one-nudge behavior for them.
    const { data: ledgerRows } = await supabase
      .from('sol_followups')
      .select('created_at')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(MAX_AUTO_NUDGES);
    const nudges = ledgerRows ?? [];
    if (nudges.length >= MAX_AUTO_NUDGES) {
      skipped.push({ conversation_id: c.id, reason: 'max_nudges' });
      continue;
    }
    if (nudges.length > 0) {
      const gapH = (now - Date.parse(nudges[0].created_at)) / (60 * 60 * 1000);
      if (gapH < MIN_NUDGE_GAP_HOURS) {
        skipped.push({ conversation_id: c.id, reason: 'nudge_too_recent', detail: `${gapH.toFixed(1)}h since touch 1` });
        continue;
      }
    } else {
      // No ledger rows: a legacy text-marker nudge means a pre-ledger touch
      // we can't time — keep the old single-nudge rule for those.
      const assistantMsgs = msgs
        .filter((m) => m.role === 'assistant')
        .map((m) => ({ content: m.content }));
      if (hasPriorFollowup(assistantMsgs)) {
        skipped.push({ conversation_id: c.id, reason: 'already_followed_up' });
        continue;
      }
    }

    // Resolve language from customer_profiles (heuristic pinning persists it
    // on every inbound). Default to 'es' — this is a Spanish-first product.
    const profile = await loadCustomerProfile(c.phone_number);
    const language: 'es' | 'en' = profile?.language === 'en' ? 'en' : 'es';

    // Quiet-hours guard. If local time at the customer is between 21:00 and
    // 08:00 we skip — a sales nudge at dinner or pre-dawn converts worse
    // than the same nudge at noon and invites opt-outs. Fall back to the
    // phone-derived tz if the profile doesn't have one stored yet (early
    // conversations before turn-1 seed has run).
    const effectiveTz = profile?.user_timezone ?? timezoneFromPhone(c.phone_number);
    const quiet = isInQuietHours(effectiveTz);
    if (quiet.isQuiet) {
      skipped.push({
        conversation_id: c.id,
        reason: 'quiet_hours',
        detail: `local hour ${quiet.localHour} in ${quiet.timezone}`,
      });
      continue;
    }

    // Build the draft and (unless dry-run) send + persist it. Model context
    // comes from the QUOTE message (the last message may be a touch-1 nudge,
    // which carries no product link).
    const draft = buildFollowupDraft({
      customerName: c.customer_name,
      lastAssistantContent: quoteMsg.content,
      language,
    });

    if (dryRun) {
      sent.push({
        conversation_id: c.id,
        phone: c.phone_number,
        language,
        preview: draft,
      });
      continue;
    }

    try {
      await sendWhatsAppMessage(c.phone_number, draft);
      // Persist so (a) the dashboard shows it, (b) the double-nudge guard
      // detects it on the next run.
      await storeMessage(c.id, 'assistant', draft);
      // Ledger row — the nudge-count source for every cron + the dashboard.
      const { error: ledgerErr } = await supabase.from('sol_followups').insert({
        conversation_id: c.id,
        phone_number: c.phone_number,
        kind: 'window_close_nudge',
        sku: extractProductModel(quoteMsg.content),
        message: draft,
      });
      if (ledgerErr) console.error(`[send-followups] ledger insert failed conv=${c.id}: ${ledgerErr.message}`);
      sent.push({
        conversation_id: c.id,
        phone: c.phone_number,
        language,
        preview: draft,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ conversation_id: c.id, error: message });
      skipped.push({ conversation_id: c.id, reason: 'send_failed', detail: message });
    }
  }

  const summary = {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    duration_ms: Date.now() - startedAt,
    window_hours: { lower: WINDOW_LOWER_HOURS, upper: WINDOW_UPPER_HOURS },
    candidates: candidates.length,
    sent: sent.length,
    skipped: skipped.length,
    errors: errors.length,
    max_send: maxSend,
    // Full details only in dry-run (or when errors exist) — keeps normal logs lean.
    details: dryRun || errors.length > 0 ? { sent, skipped, errors } : undefined,
  };

  console.log(
    `[send-followups] run=${runId} sent=${sent.length} skipped=${skipped.length} ` +
      `errors=${errors.length} candidates=${candidates.length} dry=${dryRun}`
  );

  return NextResponse.json(summary, { status: errors.length > 0 ? 207 : 200 });
}
