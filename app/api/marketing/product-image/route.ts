import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getProductImages } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Resolve the publish-ready product image (JPEG, webp-proxied) for a SKU so the
// dashboard can PREVIEW exactly what an image/text post will show before publish.
// Reuses getProductImages() — same source the publisher uses — so the preview
// matches the real post. Session-authed.

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

export async function GET(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const sku = req.nextUrl.searchParams.get('sku')?.trim();
  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 });

  const urls = await getProductImages(sku, 1);
  return NextResponse.json({ sku, image_url: urls[0] ?? null });
}
