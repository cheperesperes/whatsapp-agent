// ─────────────────────────────────────────────────────────────────────────────
// Weekly marketing plan — the data + actions behind /dashboard/marketing/semana.
//
//   GET  → posts waiting for approval or approved-and-scheduled (last 7 days →
//          next 10 days), with their text, image and the product's live stock,
//          plus what was published in the last 7 days.
//   POST → { ids: string[], action: 'approve' | 'reject' | 'unapprove' }
//          approve   pending_approval → approved   (published by the daily
//                    /api/cron/marketing-publish on the post's date)
//          unapprove approved → pending_approval
//          reject    pending_approval | approved → rejected
//
// Signed-in dashboard users only. Approving never publishes anything here.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'nodejs';

async function isSignedIn(req: NextRequest): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  const sb = createServerClient(url, anon, { cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} } });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export async function GET(req: NextRequest) {
  if (!(await isSignedIn(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sb = createServiceClient();

  const { data: campaigns, error } = await sb
    .from('marketing_campaigns')
    .select('id, date, language, status, daily_theme, product_sku, category, error_message, updated_at')
    .in('status', ['pending_approval', 'approved', 'publishing', 'published', 'partial', 'failed'])
    .gte('date', day(-7))
    .lte('date', day(10))
    .order('date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (campaigns ?? []).map((c) => c.id);
  const skus = [...new Set((campaigns ?? []).map((c) => c.product_sku).filter(Boolean))] as string[];
  const [{ data: content }, { data: products }] = await Promise.all([
    ids.length
      ? sb.from('marketing_content')
          .select('campaign_id, facebook_post, instagram_caption, image_url, image_status, video_url, facebook_post_id, instagram_post_id, published_at')
          .in('campaign_id', ids)
      : Promise.resolve({ data: [] as never[] }),
    skus.length
      ? sb.from('agent_product_catalog').select('sku, name, in_stock, sell_price').in('sku', skus)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const contentBy = new Map((content ?? []).map((c) => [c.campaign_id as string, c]));
  const productBy = new Map((products ?? []).map((p) => [String(p.sku).toUpperCase(), p]));

  const posts = (campaigns ?? []).map((c) => {
    const mc = contentBy.get(c.id);
    const p = c.product_sku ? productBy.get(String(c.product_sku).toUpperCase()) : null;
    return {
      ...c,
      facebook_post: mc?.facebook_post ?? null,
      instagram_caption: mc?.instagram_caption ?? null,
      image_url: mc?.image_url ?? null,
      image_status: mc?.image_status ?? null,
      has_video: Boolean(mc?.video_url),
      on_facebook: Boolean(mc?.facebook_post_id),
      on_instagram: Boolean(mc?.instagram_post_id),
      published_at: mc?.published_at ?? null,
      product_name: p?.name ?? null,
      product_in_stock: p ? Boolean(p.in_stock) : null,
      product_price: p?.sell_price ?? null,
    };
  });

  return NextResponse.json({ today: day(0), posts });
}

export async function POST(req: NextRequest) {
  if (!(await isSignedIn(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: { ids?: unknown; action?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body → rejected below */ }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  const action = body.action;
  if (ids.length === 0 || (action !== 'approve' && action !== 'reject' && action !== 'unapprove')) {
    return NextResponse.json({ error: 'ids[] and action (approve | reject | unapprove) are required' }, { status: 400 });
  }

  const from = action === 'approve' ? ['pending_approval'] : action === 'unapprove' ? ['approved'] : ['pending_approval', 'approved'];
  const to = action === 'approve' ? 'approved' : action === 'unapprove' ? 'pending_approval' : 'rejected';
  const { data, error } = await createServiceClient()
    .from('marketing_campaigns')
    .update({ status: to })
    .in('id', ids)
    .in('status', from)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, action, changed: data?.length ?? 0 });
}
