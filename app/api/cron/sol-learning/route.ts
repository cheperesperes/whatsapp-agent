import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';
import {
  reviewInteraction,
  consolidateLearnings,
  syncLearnings,
  invalidateLearningsCache,
  type CandidateLearning,
  type SolLearning,
} from '@/lib/learning';
import type { Message } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

// Daily interaction-learning run. For every conversation active in the last
// `days` (default 1), an AI coach reviews Sol's side of the thread against an
// Amazon-top-seller rubric, stores the review, then consolidates the
// takeaways into the bounded set of active learnings Sol's prompt injects.

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // Path 1: Vercel cron — Bearer CRON_SECRET
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) {
    return true;
  }

  // Path 2: dashboard button — authenticated Supabase user via session cookie
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (user) return true;
  }

  // Local dev without CRON_SECRET — allow
  if (!secret && process.env.VERCEL_ENV !== 'production') return true;

  return false;
}

interface ReviewableConversation {
  id: string;
  phone_number: string | null;
  customer_name: string | null;
  channel: string | null;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const sb = createServiceClient();

  const days = Math.min(7, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || 1));
  const limit = Math.min(40, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 20));
  // force=true re-reviews conversations already reviewed today (overwrites).
  const force = req.nextUrl.searchParams.get('force') === 'true';

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().split('T')[0];

  // 1) Conversations with recent activity.
  const { data: convs, error: convErr } = await sb
    .from('conversations')
    .select('id, phone_number, customer_name, channel, updated_at')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (convErr) {
    // Most likely cause on a fresh deploy: migration not applied yet.
    return NextResponse.json(
      { ok: false, error: `conversations query failed: ${convErr.message}` },
      { status: 500 }
    );
  }

  const conversations = (convs ?? []) as ReviewableConversation[];
  if (conversations.length === 0) {
    return NextResponse.json({ ok: true, reviewed: 0, skipped: 0, note: 'no recent conversations' });
  }

  // 2) Skip ones already reviewed today (unless force).
  let alreadyReviewed = new Set<string>();
  if (!force) {
    const { data: existing, error: existErr } = await sb
      .from('sol_interaction_reviews')
      .select('conversation_id')
      .eq('review_date', today)
      .in('conversation_id', conversations.map((c) => c.id));
    if (existErr) {
      return NextResponse.json(
        {
          ok: false,
          error: `sol_interaction_reviews missing? ${existErr.message}. Apply supabase/migrations/20260610_sol_interaction_learning.sql`,
        },
        { status: 500 }
      );
    }
    alreadyReviewed = new Set((existing ?? []).map((r) => r.conversation_id as string));
  }

  const toReview = conversations.filter((c) => !alreadyReviewed.has(c.id));

  // 3) Review each conversation (chunks of 4 to stay inside maxDuration).
  let reviewed = 0;
  let tooShort = 0;
  let failed = 0;
  const scores: number[] = [];
  const allCandidates: CandidateLearning[] = [];

  const CHUNK = 4;
  for (let i = 0; i < toReview.length; i += CHUNK) {
    // Hard time guard: leave ~25s for consolidation + response.
    if (Date.now() - startedAt > (maxDuration - 30) * 1000) break;

    const chunk = toReview.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (conv) => {
        try {
          const { data: msgs } = await sb
            .from('messages')
            .select('id, conversation_id, role, content, handoff_detected, created_at')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(30);

          const history = ((msgs ?? []) as Message[]).reverse();
          const userMsgCount = history.filter((m) => m.role === 'user').length;
          if (userMsgCount < 2) {
            tooShort++;
            return;
          }

          // Language: cheap heuristic from the customer profile if present.
          let language: string | null = null;
          if (conv.phone_number) {
            const { data: profile } = await sb
              .from('customer_profiles')
              .select('language, display_name')
              .eq('phone_number', conv.phone_number)
              .maybeSingle();
            language = (profile?.language as string | null) ?? null;
            if (!conv.customer_name && profile?.display_name) {
              conv.customer_name = profile.display_name as string;
            }
          }

          const review = await reviewInteraction(history, {
            customerName: conv.customer_name,
            language,
            channel: conv.channel ?? 'whatsapp',
          });
          if (!review) {
            failed++;
            return;
          }

          const { error: insErr } = await sb.from('sol_interaction_reviews').upsert(
            {
              conversation_id: conv.id,
              review_date: today,
              overall_score: review.overall_score,
              scores: review.scores,
              customer_sentiment: review.customer_sentiment,
              what_worked: review.what_worked,
              what_failed: review.what_failed,
              missed_opportunity: review.missed_opportunity,
              candidate_learnings: review.candidate_learnings,
              message_count: history.length,
              language,
              channel: conv.channel ?? 'whatsapp',
            },
            { onConflict: 'conversation_id,review_date' }
          );
          if (insErr) {
            console.warn('[sol-learning] review insert failed:', insErr.message);
            failed++;
            return;
          }

          reviewed++;
          scores.push(review.overall_score);
          allCandidates.push(...review.candidate_learnings);
        } catch (err) {
          failed++;
          console.warn('[sol-learning] review error for', conv.id, err);
        }
      })
    );
  }

  // 4) Consolidate learnings (only when today produced signal).
  let learningsActive: number | null = null;
  let consolidationRan = false;
  if (allCandidates.length > 0) {
    const { data: rows } = await sb
      .from('sol_learnings')
      .select('*')
      .eq('status', 'active');
    const all = (rows ?? []) as SolLearning[];
    const activeAuto = all.filter((l) => l.source === 'auto');
    const manual = all.filter((l) => l.source === 'manual');

    const avg = scores.length
      ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
      : 'n/a';
    const statsLine = `${reviewed} conversaciones evaluadas, nota promedio ${avg}/10, ${allCandidates.length} candidatos nuevos.`;

    const consolidated = await consolidateLearnings({
      activeAuto,
      manual,
      candidates: allCandidates,
      statsLine,
    });

    if (consolidated) {
      learningsActive = (await syncLearnings(activeAuto, consolidated)) + manual.length;
      invalidateLearningsCache();
      consolidationRan = true;
    }
  }

  const avgScore = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;

  return NextResponse.json({
    ok: true,
    window_days: days,
    candidates_considered: toReview.length,
    reviewed,
    skipped_already_reviewed: conversations.length - toReview.length,
    skipped_too_short: tooShort,
    failed,
    avg_score: avgScore,
    new_candidate_learnings: allCandidates.length,
    consolidation_ran: consolidationRan,
    learnings_active: learningsActive,
    duration_ms: Date.now() - startedAt,
  });
}
