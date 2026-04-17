import { NextResponse } from 'next/server';
import { approveKBSuggestion, rejectKBSuggestion } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// POST /api/kb-suggestions/[id] — body: { action: 'approve' | 'reject', reviewer?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const reviewer = typeof body?.reviewer === 'string' ? body.reviewer : undefined;

  if (action === 'approve') {
    const entry = await approveKBSuggestion(id, reviewer);
    if (!entry) {
      return NextResponse.json(
        { error: 'failed to approve suggestion' },
        { status: 500, headers: NO_CACHE_HEADERS }
      );
    }
    return NextResponse.json({ ok: true, entry }, { headers: NO_CACHE_HEADERS });
  }

  if (action === 'reject') {
    const ok = await rejectKBSuggestion(id, reviewer);
    if (!ok) {
      return NextResponse.json(
        { error: 'failed to reject suggestion' },
        { status: 500, headers: NO_CACHE_HEADERS }
      );
    }
    return NextResponse.json({ ok: true }, { headers: NO_CACHE_HEADERS });
  }

  return NextResponse.json(
    { error: 'action must be "approve" or "reject"' },
    { status: 400, headers: NO_CACHE_HEADERS }
  );
}
