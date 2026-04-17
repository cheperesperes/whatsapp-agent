import { NextResponse } from 'next/server';
import { getOverviewMetrics, listTopQuestions, listLostCustomers } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/overview?days=7
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(parseInt(searchParams.get('days') ?? '7', 10) || 7, 90));

  const [metrics, topQuestions, lostCustomers] = await Promise.all([
    getOverviewMetrics(days),
    listTopQuestions(days, 10),
    listLostCustomers({ silentHours: 24, minUserMessages: 3, limit: 10 }),
  ]);

  return NextResponse.json(
    { metrics, top_questions: topQuestions, lost_customers: lostCustomers },
    { headers: NO_CACHE_HEADERS }
  );
}
