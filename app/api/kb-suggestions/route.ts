import { NextResponse } from 'next/server';
import { listKBSuggestions } from '@/lib/supabase';
import type { KBSuggestionStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/kb-suggestions?status=pending|approved|rejected|all
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const statusParam = (searchParams.get('status') ?? 'pending') as KBSuggestionStatus | 'all';
  const allowed: Array<KBSuggestionStatus | 'all'> = ['pending', 'approved', 'rejected', 'all'];
  const status = allowed.includes(statusParam) ? statusParam : 'pending';

  const suggestions = await listKBSuggestions(status);
  return NextResponse.json({ suggestions }, { headers: NO_CACHE_HEADERS });
}
