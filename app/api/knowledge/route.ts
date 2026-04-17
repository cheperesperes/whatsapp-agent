import { NextResponse } from 'next/server';
import { createServiceClient, addKnowledgeEntry } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/knowledge — list entries (most-used first)
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .order('times_used', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS });
  }
  return NextResponse.json({ entries: data ?? [] }, { headers: NO_CACHE_HEADERS });
}

// POST /api/knowledge — create entry from dashboard
// Body: { question: string, answer: string, category?: string }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
  const category = typeof body?.category === 'string' && body.category.trim()
    ? body.category.trim()
    : 'general';

  if (!question || !answer) {
    return NextResponse.json(
      { error: 'question and answer are required' },
      { status: 400, headers: NO_CACHE_HEADERS }
    );
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('knowledge_base')
    .insert({ question, answer, category, source: 'dashboard' })
    .select()
    .single();

  if (error || !data) {
    // Fall back to lib helper (handles edge cases like RLS) — this also makes the
    // endpoint work if the table's constraints differ from what we expect.
    const entry = await addKnowledgeEntry(question, answer, category);
    if (!entry) {
      return NextResponse.json(
        { error: error?.message ?? 'failed to create entry' },
        { status: 500, headers: NO_CACHE_HEADERS }
      );
    }
    return NextResponse.json({ entry }, { headers: NO_CACHE_HEADERS });
  }

  return NextResponse.json({ entry: data }, { headers: NO_CACHE_HEADERS });
}
