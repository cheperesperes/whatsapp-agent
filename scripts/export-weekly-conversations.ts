/**
 * Export the last N days of WhatsApp conversations for the Sol Weekly Review prompt.
 *
 * Output format (matches docs/sol_weekly_review_prompt.md spec):
 *   === CONVERSACIÓN N ===
 *   Fecha: YYYY-MM-DD HH:mm (America/New_York)
 *   Phone: +1...   Nombre: ...   Segmento: ...   Estado: ...   Lead: ...
 *   Cliente: <text>
 *   Sol:     <text>
 *   ...
 *
 * Notes:
 *   - `messages.content` for the assistant role is already the customer-facing
 *     text (internal tags `[METRIC:]`, `[HANDOFF:]`, `[OPTOUT:]`, `[SEND_IMAGE:]`
 *     are stripped by the webhook before insert). The `handoff_detected` flag
 *     from the messages table IS surfaced as `[HANDOFF detected]` on the
 *     assistant turn so the reviewer can see escalations.
 *   - A conversation is included if it has ≥1 message in the window. If the
 *     conversation started before the window, only in-window messages are
 *     printed and a `(continuación)` marker is added.
 *
 * Usage (from worktree root):
 *   npx tsx scripts/export-weekly-conversations.ts                         # last 7 days
 *   npx tsx scripts/export-weekly-conversations.ts --days 14
 *   npx tsx scripts/export-weekly-conversations.ts --from 2026-04-13 --to 2026-04-20
 *   npx tsx scripts/export-weekly-conversations.ts --out review-2026-W16.txt
 *
 * Requires env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env.local).
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ────────────────────────────────────────────────────────────────────
// .env.local loader (no dotenv dependency in this repo)
// ────────────────────────────────────────────────────────────────────
function loadEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, val] = m;
      if (process.env[key]) continue;
      process.env[key] = val.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // .env.local not present — assume env is already populated
  }
}

// ────────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────────
function parseArgs(): { fromIso: string; toIso: string; out?: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const out = get('--out');
  const fromArg = get('--from');
  const toArg = get('--to');
  const daysArg = get('--days');

  let from: Date;
  let to: Date;
  if (fromArg && toArg) {
    from = new Date(`${fromArg}T00:00:00.000Z`);
    to = new Date(`${toArg}T23:59:59.999Z`);
  } else {
    const days = daysArg ? Number.parseInt(daysArg, 10) : 7;
    if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive integer, got "${daysArg}"`);
    to = new Date();
    from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  }

  return { fromIso: from.toISOString(), toIso: to.toISOString(), out };
}

// ────────────────────────────────────────────────────────────────────
// Supabase
// ────────────────────────────────────────────────────────────────────
type ConversationRow = {
  id: string;
  phone_number: string;
  customer_name: string | null;
  customer_segment: string | null;
  status: string | null;
  escalated: boolean | null;
  escalation_reason: string | null;
  lead_quality: string | null;
  lead_reason: string | null;
  product_interest: string | null;
  opted_out: boolean | null;
  recent_dispatched_skus: string[] | null;
  created_at: string;
};

type MessageRow = {
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  handoff_detected: boolean | null;
  created_at: string;
};

function fmtTsET(iso: string): string {
  const d = new Date(iso);
  // YYYY-MM-DD HH:mm in America/New_York
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : prefix + l))
    .join('\n');
}

async function main(): Promise<void> {
  loadEnvLocal();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const { fromIso, toIso, out } = parseArgs();
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Find conversation_ids that have ≥1 message in the window
  const { data: msgWindow, error: msgErr } = await supabase
    .from('messages')
    .select('conversation_id')
    .gte('created_at', fromIso)
    .lte('created_at', toIso);
  if (msgErr) throw msgErr;

  const convIds = Array.from(new Set((msgWindow ?? []).map((m) => m.conversation_id))).filter(Boolean);
  if (convIds.length === 0) {
    console.error(`No conversations with messages between ${fromIso} and ${toIso}.`);
    process.exit(0);
  }

  // 2. Fetch those conversations + ALL their messages in the window
  const [{ data: convs, error: cErr }, { data: msgs, error: mErr }] = await Promise.all([
    supabase
      .from('conversations')
      .select(
        'id, phone_number, customer_name, customer_segment, status, escalated, escalation_reason, lead_quality, lead_reason, product_interest, opted_out, recent_dispatched_skus, created_at'
      )
      .in('id', convIds),
    supabase
      .from('messages')
      .select('conversation_id, role, content, handoff_detected, created_at')
      .in('conversation_id', convIds)
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .order('created_at', { ascending: true }),
  ]);
  if (cErr) throw cErr;
  if (mErr) throw mErr;

  const convsTyped = (convs ?? []) as ConversationRow[];
  const msgsTyped = (msgs ?? []) as MessageRow[];

  // 3. Group messages by conversation_id, preserve chronological order
  const byConv = new Map<string, MessageRow[]>();
  for (const m of msgsTyped) {
    const arr = byConv.get(m.conversation_id) ?? [];
    arr.push(m);
    byConv.set(m.conversation_id, arr);
  }

  // 4. Sort conversations by first in-window message timestamp ASC
  const convsSorted = convsTyped
    .map((c) => ({ conv: c, firstMsg: byConv.get(c.id)?.[0]?.created_at ?? c.created_at }))
    .sort((a, b) => a.firstMsg.localeCompare(b.firstMsg));

  // 5. Format
  const lines: string[] = [];
  lines.push(`# Sol Weekly Review — Conversations Export`);
  lines.push(`# Range: ${fromIso}  →  ${toIso}`);
  lines.push(`# Window: America/New_York`);
  lines.push(`# Total conversations: ${convsSorted.length}`);
  lines.push(`# Total messages: ${msgsTyped.length}`);
  lines.push('');

  let n = 0;
  for (const { conv } of convsSorted) {
    n += 1;
    const turns = byConv.get(conv.id) ?? [];
    if (turns.length === 0) continue;

    const startedBeforeWindow = new Date(conv.created_at) < new Date(fromIso);
    const segment = conv.customer_segment || 'Sin clasificar';
    const status = conv.status || 'unknown';
    const lead = conv.lead_quality
      ? `${conv.lead_quality}${conv.lead_reason ? ` (${conv.lead_reason})` : ''}`
      : 'sin scoring';
    const escalated = conv.escalated ? `escalated → ${conv.escalation_reason ?? 'sin razón'}` : 'no escalated';
    const optout = conv.opted_out ? '  ⚠ OPT-OUT' : '';
    const interest = conv.product_interest ? `  Interés: ${conv.product_interest}` : '';

    lines.push(`=== CONVERSACIÓN ${n} ===`);
    lines.push(`Fecha primera (ventana): ${fmtTsET(turns[0].created_at)} ET`);
    lines.push(
      `Phone: ${conv.phone_number}   Nombre: ${conv.customer_name ?? '—'}   Segmento: ${segment}   Estado: ${status}   Lead: ${lead}   ${escalated}${optout}${interest}`
    );
    if (startedBeforeWindow) {
      lines.push(`(continuación de conversación previa — iniciada ${fmtTsET(conv.created_at)} ET)`);
    }
    lines.push('');

    for (const t of turns) {
      const ts = fmtTsET(t.created_at);
      const handoff = t.handoff_detected ? '  [HANDOFF detected]' : '';
      const speaker = t.role === 'user' ? 'Cliente' : 'Sol    ';
      const body = t.content?.trim() ?? '';
      lines.push(`[${ts}] ${speaker}:${handoff} ${indent(body, '          ')}`);
    }
    lines.push('');
  }

  const output = lines.join('\n');

  if (out) {
    writeFileSync(resolve(process.cwd(), out), output, 'utf-8');
    console.error(`Wrote ${convsSorted.length} conversations (${msgsTyped.length} messages) → ${out}`);
  } else {
    process.stdout.write(output);
    console.error(
      `\n# Exported ${convsSorted.length} conversations (${msgsTyped.length} messages). Pipe to a file with: > review-$(date +%Y-W%V).txt`
    );
  }
}

main().catch((err) => {
  console.error('export-weekly-conversations failed:', err);
  process.exit(1);
});
