import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 240;

// ─────────────────────────────────────────────────────────────────────────────
// Hourly follow-up dispatcher — replaces four separate hourly crons
// (send-followups :00, sales-followup :15, paylink-nudge :30,
// web-lead-followup :45) with ONE schedule. Runs the same four jobs
// SEQUENTIALLY in the old firing order, so send pacing and non-overlap are
// preserved; one cron slot to monitor instead of four. The individual routes
// still exist and accept the same Bearer CRON_SECRET, so any job can be
// re-run manually or re-scheduled on its own without code changes.
//
// Each job gets a hard 50s timeout — a hung job is reported and skipped,
// never allowed to starve the jobs after it.
// ─────────────────────────────────────────────────────────────────────────────

const JOBS = [
  'send-followups',
  'sales-followup',
  'paylink-nudge',
  'web-lead-followup',
] as const;

const PER_JOB_TIMEOUT_MS = 50_000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const origin = req.nextUrl.origin;
  const results: Record<string, unknown> = {};

  for (const job of JOBS) {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${origin}/api/cron/${job}`, {
        headers: auth ? { authorization: auth } : undefined,
        signal: AbortSignal.timeout(PER_JOB_TIMEOUT_MS),
        cache: 'no-store',
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }
      results[job] = { status: res.status, ms: Date.now() - startedAt, body };
    } catch (err) {
      results[job] = {
        status: 'error',
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json({ ok: true, ran: JOBS.length, results });
}
