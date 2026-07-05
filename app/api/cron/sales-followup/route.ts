import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'node:crypto';
import { createServiceClient, loadCustomerProfile, storeMessage } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import {
  buildQuoteNudgeDraft,
  hasPriorFollowup,
  PAYLINK_SENT_RE,
  PRODUCT_QUOTE_RE,
  extractProductModel,
  MAX_AUTO_NUDGES,
  type NudgeLanguage,
} from '@/lib/followup';
import { detectLanguage } from '@/lib/language';
import { isInQuietHours, timezoneFromPhone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Quote-abandonment nudge (touch 1 of the sales ladder) — same-evening sibling
// of paylink-nudge, for the far more common case: Sol QUOTED a product
// (price + link), the customer went quiet, and nobody followed up until the
// generic 18-24h cron — by which time the evening's buying intent is gone.
// Real cases this closes (2026-06-11): juntty (F5000, said "240v", silent),
// Kerenski (E3600 @ $946, silent), Will (choosing between models, silent).
//
// SAFE BY DEFAULT: unless SALES_FOLLOWUP_ENABLED=true, every run is forced
// into dry-run (logs candidates, sends NOTHING).
//
// Guards (any short-circuits a candidate):
//   • Auth: CRON_SECRET bearer OR logged-in dashboard session.
//   • Window: last activity 2-6h ago; customer's last inbound ≤23h ago
//     (WhatsApp free-form policy window) and ≥2h ago (real silence).
//   • Customer-silent: last message is Sol's.
//   • Quote actually sent: last assistant message has a product link and is
//     NOT a pay-link (pay-link leads belong to paylink-nudge).
//   • NOT already ordered (orders by phone, last ~26h) / not converted.
//   • No prior automated nudge: sol_followups ledger row OR legacy text
//     markers → skip. This cron only ever sends touch 1.
//   • Out-of-USA declined leads: any user message mentioning "cuba" → skip
//     (nudging against a shipping decline reads tone-deaf).
//   • Quiet hours (21:00-08:00 customer-local). Per-run cap.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_LOWER_HOURS = 2;
const WINDOW_UPPER_HOURS = 6;
const MESSAGE_TAIL = 12;
const POLICY_WINDOW_HOURS = 23;

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

function phoneKey(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.slice(-10);
}

interface CandidateRow {
  id: string;
  phone_number: string;
  customer_name: string | null;
  converted_at: string | null;
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
  // SAFE DEFAULT: only send for real when explicitly enabled.
  const enabled = (process.env.SALES_FOLLOWUP_ENABLED ?? '').toLowerCase() === 'true';
  const dryRun = !enabled || url.searchParams.get('dry') === '1';
  const maxSend = envNumber('SALES_FOLLOWUP_MAX_SEND', 25);

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();
  const now = Date.now();

  const lowerBound = new Date(now - WINDOW_UPPER_HOURS * 60 * 60 * 1000).toISOString();
  const upperBound = new Date(now - WINDOW_LOWER_HOURS * 60 * 60 * 1000).toISOString();

  const { data: convRows, error: convErr } = await supabase
    .from('conversations')
    .select('id, phone_number, customer_name, converted_at, updated_at')
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

  // Recently-paid phones — never nudge someone who just bought.
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

    if (c.converted_at || paidPhoneKeys.has(phoneKey(c.phone_number))) {
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
    // A QUOTE was sent (product link), and it is NOT a pay-link message —
    // pay-link abandoners are paylink-nudge's territory.
    if (!PRODUCT_QUOTE_RE.test(last.content) || PAYLINK_SENT_RE.test(last.content)) {
      skipped.push({ conversation_id: c.id, reason: 'no_quote_in_last_message' });
      continue;
    }

    // Engagement + policy window from the CUSTOMER's last inbound.
    const lastUser = msgs.find((m) => m.role === 'user');
    if (!lastUser) {
      skipped.push({ conversation_id: c.id, reason: 'no_user_messages' });
      continue;
    }
    const userAgeH = (now - Date.parse(lastUser.created_at)) / (60 * 60 * 1000);
    if (userAgeH > POLICY_WINDOW_HOURS) {
      skipped.push({ conversation_id: c.id, reason: 'outside_24h_window', detail: `last inbound ${userAgeH.toFixed(1)}h` });
      continue;
    }
    if (userAgeH < WINDOW_LOWER_HOURS) {
      skipped.push({ conversation_id: c.id, reason: 'too_soon', detail: `last inbound ${userAgeH.toFixed(1)}h` });
      continue;
    }

    // Out-of-USA declined leads: a "cuba" mention in any user message means
    // the conversation hit the USA-only wall — a sales nudge reads tone-deaf.
    if (msgs.some((m) => m.role === 'user' && /\bcuba\b/i.test(m.content))) {
      skipped.push({ conversation_id: c.id, reason: 'out_of_usa_lead' });
      continue;
    }

    // One automated touch-1 max: ledger row OR legacy text marker → skip.
    // Use a normal SELECT (not head:true/count:exact) — the HEAD request path
    // returns null count on some Vercel Node.js deployments, silently bypassing
    // this guard and causing repeat nudges (observed: 3× identical message to
    // same customer, 3h apart, 2026-07-04/05).
    const { data: priorNudgeRows } = await supabase
      .from('sol_followups')
      .select('id')
      .eq('conversation_id', c.id)
      .limit(MAX_AUTO_NUDGES);
    const nudgeCount = priorNudgeRows?.length ?? 0;
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant').map((m) => ({ content: m.content }));
    if (nudgeCount > 0 || hasPriorFollowup(assistantMsgs)) {
      skipped.push({ conversation_id: c.id, reason: 'already_nudged' });
      continue;
    }

    // Language: persisted es/en, else detect from the last inbound.
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

    // Variant rotates by conversation id so different leads on the same run
    // don't receive identical copy (deterministic — resume-safe, testable).
    const variant = parseInt(c.id.replace(/-/g, '').slice(0, 6), 16);
    const draft = buildQuoteNudgeDraft({
      customerName: c.customer_name,
      lastAssistantContent: last.content,
      language,
      variant,
    });
    const sku = extractProductModel(last.content);

    if (dryRun) {
      sent.push({ conversation_id: c.id, phone: c.phone_number, name: c.customer_name, language, sku, preview: draft });
      continue;
    }

    try {
      await sendWhatsAppMessage(c.phone_number, draft);
      await storeMessage(c.id, 'assistant', draft);
      // Ledger row — the dedupe/count source for every cron + the dashboard.
      const { error: ledgerErr } = await supabase.from('sol_followups').insert({
        conversation_id: c.id,
        phone_number: c.phone_number,
        kind: 'quote_nudge',
        sku,
        message: draft,
      });
      if (ledgerErr) console.error(`[sales-followup] ledger insert failed conv=${c.id}: ${ledgerErr.message}`);
      sent.push({ conversation_id: c.id, phone: c.phone_number, name: c.customer_name, language, sku, preview: draft });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ conversation_id: c.id, error: message });
      skipped.push({ conversation_id: c.id, reason: 'send_failed', detail: message });
    }
  }

  console.log(
    `[sales-followup] run=${runId} ${dryRun ? 'WOULD send' : 'sent'}=${sent.length} skipped=${skipped.length} errors=${errors.length} enabled=${enabled}`
  );

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
