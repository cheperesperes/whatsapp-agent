import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Hand-edit a campaign's post text before publishing (no AI regenerate needed).
// Only whitelisted text fields are editable. Session-authed.

const EDITABLE = [
  'facebook_post',
  'instagram_caption',
  'youtube_title',
  'youtube_description',
] as const;
type EditableField = (typeof EDITABLE)[number];

async function requireAuth(req: NextRequest): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }
  const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { campaign_id?: string; fields?: Record<string, string> } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  if (!body.campaign_id || !body.fields || typeof body.fields !== 'object') {
    return NextResponse.json({ error: 'campaign_id and fields required' }, { status: 400 });
  }

  // Whitelist + length-cap the incoming fields.
  const patch: Partial<Record<EditableField, string>> = {};
  for (const key of EDITABLE) {
    const v = body.fields[key];
    if (typeof v === 'string') patch[key] = v.slice(0, 5000);
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields provided' }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from('marketing_content')
    .update(patch)
    .eq('campaign_id', body.campaign_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updated: Object.keys(patch) });
}
