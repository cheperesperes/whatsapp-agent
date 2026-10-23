import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import type { ReviewDimensionId } from '@/lib/learning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dashboard data for /dashboard/learning. Session-protected by middleware
// (this path is NOT in PUBLIC_PATHS), so reads can use the service client.

const DIMENSION_IDS: ReviewDimensionId[] = [
  'calidez_humana',
  'obsesion_cliente',
  'confianza',
  'proactividad',
  'cierre_natural',
  'idioma_tono',
];

export async function GET() {
  const sb = createServiceClient();

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [reviewsRes, learningsRes] = await Promise.all([
    sb
      .from('sol_interaction_reviews')
      .select(
        'id, conversation_id, review_date, overall_score, scores, customer_sentiment, what_worked, what_failed, missed_opportunity, message_count, language, channel, created_at, conversations(phone_number, customer_name)'
      )
      .order('created_at', { ascending: false })
      .limit(50),
    sb
      .from('sol_learnings')
      .select('*')
      .order('status', { ascending: true }) // active, proposed, rejected, retired
      .order('updated_at', { ascending: false })
      .limit(60),
  ]);

  if (reviewsRes.error || learningsRes.error) {
    const msg = reviewsRes.error?.message ?? learningsRes.error?.message ?? 'unknown';
    const missing = /relation .* does not exist|Could not find/i.test(msg);
    return NextResponse.json(
      {
        error: msg,
        setup_needed: missing,
        hint: missing
          ? 'Apply supabase/migrations/20260610_sol_interaction_learning.sql to create the learning tables.'
          : undefined,
      },
      { status: 500 }
    );
  }

  const reviews = reviewsRes.data ?? [];
  const recent = reviews.filter((r) => r.review_date >= since7d);

  const avg = (nums: number[]) =>
    nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;

  const dimensionAverages: Record<string, number | null> = {};
  for (const id of DIMENSION_IDS) {
    dimensionAverages[id] = avg(
      recent
        .map((r) => (r.scores as Record<string, number> | null)?.[id])
        .filter((n): n is number => typeof n === 'number')
    );
  }

  const sentimentCounts = { contento: 0, neutral: 0, frustrado: 0 } as Record<string, number>;
  for (const r of recent) {
    const s = (r.customer_sentiment as string) ?? 'neutral';
    sentimentCounts[s] = (sentimentCounts[s] ?? 0) + 1;
  }

  // Latest practice run (fail-soft: the table may not exist before the 2026-10-23 migration).
  let practice: {
    run_id: string; created_at: string; passed: number; total: number; model: string | null;
    failing: { scenario_id: string; title: string | null; failures: { id: string; desc: string }[] }[];
  } | null = null;
  try {
    const { data: last } = await sb
      .from('sol_practice_runs')
      .select('run_id')
      .order('created_at', { ascending: false })
      .limit(1);
    const runId = last?.[0]?.run_id as string | undefined;
    if (runId) {
      const { data: rows } = await sb
        .from('sol_practice_runs')
        .select('scenario_id, title, passed, failures, model, created_at')
        .eq('run_id', runId);
      const list = rows ?? [];
      practice = {
        run_id: runId,
        created_at: (list[0]?.created_at as string) ?? new Date().toISOString(),
        passed: list.filter((r) => r.passed).length,
        total: list.length,
        model: (list[0]?.model as string | null) ?? null,
        failing: list
          .filter((r) => !r.passed)
          .map((r) => ({
            scenario_id: r.scenario_id as string,
            title: (r.title as string | null) ?? null,
            failures: (r.failures as { id: string; desc: string }[]) ?? [],
          })),
      };
    }
  } catch {
    practice = null;
  }

  return NextResponse.json({
    practice,
    stats: {
      reviewed_7d: recent.length,
      avg_score_7d: avg(recent.map((r) => r.overall_score as number)),
      dimension_averages: dimensionAverages,
      sentiment_counts: sentimentCounts,
      last_run: reviews[0]?.created_at ?? null,
    },
    reviews,
    learnings: learningsRes.data ?? [],
  });
}
