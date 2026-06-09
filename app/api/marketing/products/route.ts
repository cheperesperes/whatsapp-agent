import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServiceClient, applyLivePricing } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

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

  const sb = createServiceClient();
  const { data, error } = await sb
    .from('agent_product_catalog')
    .select('sku, name, category, sell_price, original_price, discount_percentage, battery_capacity_wh, output_watts')
    .eq('in_stock', true)
    .order('category');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Show LIVE storefront prices in the picker (read-only) so it matches what the
  // generated post quotes. Drop anything the storefront marks out of stock.
  const products = await applyLivePricing(data ?? [], { dropOutOfStock: true });
  products.sort(
    (a, b) =>
      String(a.category ?? '').localeCompare(String(b.category ?? '')) ||
      Number(a.sell_price ?? 0) - Number(b.sell_price ?? 0),
  );

  return NextResponse.json({ products });
}
