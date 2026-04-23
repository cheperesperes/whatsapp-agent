import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { fetchGA4Summary } from '@/lib/marketing/integrations/google-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const configured = Boolean(process.env.GA4_CLIENT_EMAIL && process.env.GA4_PRIVATE_KEY);
  if (!configured) {
    return NextResponse.json({
      configured: false,
      message: 'Add GA4_CLIENT_EMAIL and GA4_PRIVATE_KEY to Vercel env vars',
    });
  }

  try {
    const summary = await fetchGA4Summary();
    return NextResponse.json({ configured: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
