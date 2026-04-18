import { NextResponse } from 'next/server';
import { listLostCustomers } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/lost-customers?silentHours=24&minUserMessages=3&limit=100
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const silentHours = parseInt(searchParams.get('silentHours') ?? '24', 10) || 24;
  const minUserMessages = parseInt(searchParams.get('minUserMessages') ?? '3', 10) || 3;
  const limit = parseInt(searchParams.get('limit') ?? '100', 10) || 100;

  const lost = await listLostCustomers({ silentHours, minUserMessages, limit });
  return NextResponse.json({ lost }, { headers: NO_CACHE_HEADERS });
}
