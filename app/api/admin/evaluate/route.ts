import { NextResponse } from 'next/server';
import {
  createServiceClient,
  createKBSuggestion,
  loadRecentMessages,
} from '@/lib/supabase';
import {
  judgeConversation,
  SCORECARD_RULE_LABELS,
  type ScorecardResult,
  type ScorecardRuleId,
} from '@/lib/anthropic';
import type { Conversation } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

interface AggregateRule {
  label: string;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
}

interface EvaluateResponse {
  window_days: number;
  sampled: number;
  judged: number;
  self_teach_suggestions_created: number;
  rules: Record<ScorecardRuleId, AggregateRule>;
  worst_offenders: ScorecardResult[];
  all_scorecards: ScorecardResult[];
}

// POST /api/admin/evaluate?days=7&sample=20
// Samples up to N conversations from the last `days` days that have enough
// customer turns to be worth judging, runs the LLM judge on each, and writes
// any teachable failures into the kb_suggestions queue for operator review.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(parseInt(searchParams.get('days') ?? '7', 10) || 7, 90));
  const sample = Math.max(1, Math.min(parseInt(searchParams.get('sample') ?? '15', 10) || 15, 50));

  const supabase = createServiceClient();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, phone_number, customer_name, status, updated_at')
    .gte('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }

  const pool = (convs ?? []) as Pick<Conversation, 'id' | 'phone_number' | 'customer_name' | 'status' | 'updated_at'>[];
  const picked = pool.slice(0, sample);

  const results = await Promise.all(
    picked.map(async (c) => {
      const messages = await loadRecentMessages(c.id, 30);
      return judgeConversation(c.id, messages);
    })
  );

  const scorecards = results.filter((r): r is ScorecardResult => r !== null);

  const ruleIds = Object.keys(SCORECARD_RULE_LABELS) as ScorecardRuleId[];
  const rules = {} as Record<ScorecardRuleId, AggregateRule>;
  for (const id of ruleIds) {
    rules[id] = { label: SCORECARD_RULE_LABELS[id], pass_count: 0, fail_count: 0, pass_rate: 0 };
  }
  for (const s of scorecards) {
    for (const id of ruleIds) {
      if (s.rules[id]?.passed) rules[id].pass_count++;
      else rules[id].fail_count++;
    }
  }
  for (const id of ruleIds) {
    const total = rules[id].pass_count + rules[id].fail_count;
    rules[id].pass_rate = total === 0 ? 0 : rules[id].pass_count / total;
  }

  let suggestionsCreated = 0;
  for (const s of scorecards) {
    if (!s.teachable_suggestion) continue;
    const created = await createKBSuggestion({
      question: s.teachable_suggestion.question,
      answer: s.teachable_suggestion.answer,
      category: s.teachable_suggestion.category,
      conversation_id: s.conversation_id,
      rationale: s.teachable_suggestion.rationale || 'Generado por el juez de calidad de Sol',
    });
    if (created) suggestionsCreated++;
  }

  const worstOffenders = [...scorecards]
    .sort((a, b) => a.pass_count - b.pass_count)
    .slice(0, 5);

  const body: EvaluateResponse = {
    window_days: days,
    sampled: picked.length,
    judged: scorecards.length,
    self_teach_suggestions_created: suggestionsCreated,
    rules,
    worst_offenders: worstOffenders,
    all_scorecards: scorecards,
  };

  return NextResponse.json(body, { headers: NO_CACHE_HEADERS });
}
