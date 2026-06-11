import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'node:crypto';
import { createServiceClient, loadCustomerProfile, storeMessage } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import {
  buildPaylinkNudgeDraft,
  hasPriorFollowup,
  PAYLINK_SENT_RE,
  type NudgeLanguage,
} from '@/lib/followup';
import { detectLanguage } from '@/lib/language';
import { isInQuietHours, timezoneFromPhone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Pay-link abandonment nudge — the same-evening sibling of send-followups.
//
// Gap it closes: the generic follow-up cron only nudges silent warm leads at
// 18-24h. A customer who already got a PayPal pay-link is in "about to pay"
// mode — 18h late is useless, ~2-4h is gold. This cron catches exactly that
// case: pay-link sent, no order recorded, customer silent, still inside the
// 24h WhatsApp window — and sends ONE payment-help nudge.
//
// SAFE BY DEFAULT: unless PAYLINK_NUDGE_ENABLED=true, every run is forced into
// dry-run (logs candidates, sends NOTHING). So the scheduled cron is harmless
// until the operator explicitly opts in after reviewing the dry-run output.
//
// One nudge only: the opener phrases live in FOLLOWUP_MARKER_PATTERNS, shared
// with send-followups, so a lead nudged here is never also nudged there.
//
// Guards (any short-circuits a candidate):
//   • Auth: CRON_SECRET bearer OR logged-in dashboard session.
//   • Force dry-run unless PAYLINK_NUDGE_ENABLED=true. `?dry=1` also forces it.
//   • Window: last activity 2-6h ago (room to pay on their own first, still
//     same-evening + well inside the 24h policy window).
//   • Customer-silent: last message is Sol's, not the customer's.
//   • Pay-link actually sent: last assistant message matches PAYLINK_SENT_RE.
//   • NOT already paid: no orders row for this phone in the last ~26h. (The
//     single most important guard — never nudge someone who just paid.)
//   • No prior nudge (either cron). No opt-out / escalated / closed.
//   • Quiet hours (21:00-08:00 local by phone tz).
//   • Per-run cap PAYLINK_NUDGE_MAX_SEND (default 25).
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_LOWER_HOURS = 2;
const WINDOW_UPPER_HOURS = 6;
const MESSAGE_TAIL = 12;
const POLICY_WINDOW_HOURS = 23; // hard 24h WhatsApp window, with margin

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return true;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (user) return true;
  }

  if (!secret && process.env.VERCEL_ENV !== 'production') return true;
  return false;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Last 10 digits — robust to +1 / spaces / formatting drift between the WA
// number on the conversation and the phone we stamped on the order.
function phoneKey(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.slice(-10);
}

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

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  // SAFE DEFAULT: only send for real when explicitly enabled. Anything else
  // (unset, false, ?dry=1) runs but sends nothing.
  const enabled = (process.env.PAYLINK_NUDGE_ENABLED ?? '').toLowerCase() === 'true';
  const dryRun = !enabled || url.searchParams.get('dry') === '1';
  const maxSend = envNumber('PAYLINK_NUDGE_MAX_SEND', 25);

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();
  const now = Date.now();

  const lowerBound = new Date(now - WINDOW_UPPER_HOURS * 60 * 60 * 1000).toISOString();
  const upperBound = new Date(now - WINDOW_LOWER_HOURS * 60 * 60 * 1000).toISOString();

  // ── Candidate conversations: last activity 2-6h ago, eligible ──
  const { data: convRows, error: convErr } = await supabase
    .from('conversations')
    .select('id, phone_number, customer_name, updated_at')
    .eq('channel', 'whatsapp')
    .eq('opted_out', false)
    .eq('escalated', false)
    .neq('status', 'closed')
    .not('phone_number', 'is', null)
    .gte('updated_at', lowerBound)
    .lte('updated_at', upperBound)
    .order('updated_at', { ascending: true })
    .limit(maxSend * 4);

  if (convErr) {
    return NextResponse.json(
      { error: `conversations read failed: ${convErr.message}`, run_id: runId },
      { status: 500 }
    );
  }
  const candidates = (convRows ?? []) as CandidateRow[];

  // ── Recently-paid phones (last ~26h) → the "already ordered" guard set ──
  const ordersSince = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const { data: orderRows } = await supabase
    .from('orders')
    .select('customer_phone, created_at')
    .gte('created_at', ordersSince)
    .not('customer_phone', 'is', null);
  const paidPhoneKeys = new Set(
    (orderRows ?? []).map((o) => phoneKey((o as { customer_phone: string }).customer_phone)).filter(Boolean)
  );

  const sent: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (const c of candidates) {
    if (sent.length >= maxSend) break;

    // Guard: already paid.
    if (paidPhoneKeys.has(phoneKey(c.phone_number))) {
      skipped.push({ conversation_id: c.id, reason: 'already_ordered' });
      continue;
    }

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

    // Customer must be silent (last message is Sol's).
    const last = msgs[0];
    if (last.role !== 'assistant') {
      skipped.push({ conversation_id: c.id, reason: 'customer_replied' });
      continue;
    }
    // Sol must have actually sent a pay-link (not just a product link).
    if (!PAYLINK_SENT_RE.test(last.content)) {
      skipped.push({ conversation_id: c.id, reason: 'no_paylink_sent' });
      continue;
    }
    // Must have engaged, and their last inbound must be inside the 24h window.
    const lastUser = msgs.find((m) => m.role === 'user');
    if (!lastUser) {
      skipped.push({ conversation_id: c.id, reason: 'no_user_messages' });
      continue;
    }
    const userAgeH = (now - Date.parse(lastUser.created_at)) / (60 * 60 * 1000);
    if (userAgeH > POLICY_WINDOW_HOURS) {
      // Last inbound is older than our tail could see, or genuinely > 23h.
      skipped.push({ conversation_id: c.id, reason: 'outside_24h_window', detail: `last inbound ${userAgeH.toFixed(1)}h` });
      continue;
    }

    // One nudge only — shared markers across both crons.
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant').map((m) => ({ content: m.content }));
    if (hasPriorFollowup(assistantMsgs)) {
      skipped.push({ conversation_id: c.id, reason: 'already_nudged' });
      continue;
    }

    // Language: persisted es/en, else detect fr/ht/es/en from the last inbound.
    const profile = await loadCustomerProfile(c.phone_number);
    let language: NudgeLanguage;
    if (profile?.language === 'en' || profile?.language === 'es') {
      language = profile.language;
    } else {
      const d = detectLanguage(lastUser.content);
      language = d === 'unknown' ? 'es' : d;
    }

    // Quiet hours (customer-local).
    const tz = profile?.user_timezone ?? timezoneFromPhone(c.phone_number);
    const quiet = isInQuietHours(tz);
    if (quiet.isQuiet) {
      skipped.push({ conversation_id: c.id, reason: 'quiet_hours', detail: `local hour ${quiet.localHour} ${quiet.timezone}` });
      continue;
    }

    const draft = buildPaylinkNudgeDraft({
      customerName: c.customer_name,
      lastAssistantContent: last.content,
      language,
    });

    if (dryRun) {
      sent.push({ conversation_id: c.id, phone: c.phone_number, name: c.customer_name, language, preview: draft });
      continue;
    }

    try {
      await sendWhatsAppMessage(c.phone_number, draft);
      await storeMessage(c.id, 'assistant', draft);
      sent.push({ conversation_id: c.id, phone: c.phone_number, name: c.customer_name, language, preview: draft });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ conversation_id: c.id, error: message });
      skipped.push({ conversation_id: c.id, reason: 'send_failed', detail: message });
    }
  }

  return NextResponse.json({
    ok: true,
    run_id: runId,
    enabled,
    dry_run: dryRun,
    window_hours: { lower: WINDOW_LOWER_HOURS, upper: WINDOW_UPPER_HOURS },
    candidates: candidates.length,
    [dryRun ? 'would_send' : 'sent']: sent.length,
    skipped: skipped.length,
    errors: errors.length,
    max_send: maxSend,
    details: { sent, skipped, errors },
    duration_ms: Date.now() - startedAt,
  });
}
