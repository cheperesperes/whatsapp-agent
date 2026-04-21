import { NextResponse } from 'next/server';
import { createServiceClient, loadCustomerProfile } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

/**
 * GET /api/conversations/[id]/profile
 *
 * Returns the customer_profiles row for the conversation's phone_number.
 * The dashboard CustomerCard uses this to render the structured `reading`
 * as chips (intent stage, knowledge level, urgency, price sensitivity,
 * objection themes, arrival source).
 *
 * Two-hop lookup: conversations[id] → phone_number → customer_profiles.
 * Keeps the API surface conversation-scoped so the client doesn't need to
 * learn about phones. Returns { profile: null } with 200 (not 404) when the
 * profile hasn't been populated yet — the card renders an empty state
 * rather than a loud error.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('phone_number')
    .eq('id', id)
    .maybeSingle();

  if (convErr) {
    return NextResponse.json(
      { error: convErr.message },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation not found' },
      { status: 404, headers: NO_CACHE_HEADERS }
    );
  }

  const profile = await loadCustomerProfile(conv.phone_number);
  return NextResponse.json({ profile }, { headers: NO_CACHE_HEADERS });
}
