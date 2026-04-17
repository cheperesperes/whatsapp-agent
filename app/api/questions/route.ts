import { NextResponse } from 'next/server';
import { listCustomerQuestions } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/questions?mode=questions|all&sinceDays=7|30|all&limit=200
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const modeParam = searchParams.get('mode');
  const mode: 'questions' | 'all' = modeParam === 'all' ? 'all' : 'questions';

  const sinceParam = searchParams.get('sinceDays');
  const sinceDays =
    sinceParam === 'all' || sinceParam === null ? null : Math.max(1, parseInt(sinceParam, 10) || 0) || null;

  const limitParam = parseInt(searchParams.get('limit') ?? '200', 10);
  const limit = Number.isFinite(limitParam) ? limitParam : 200;

  const questions = await listCustomerQuestions({ mode, sinceDays, limit });
  return NextResponse.json({ questions }, { headers: NO_CACHE_HEADERS });
}
