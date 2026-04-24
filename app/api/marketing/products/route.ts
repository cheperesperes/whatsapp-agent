import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from('agent_product_catalog')
    .select('sku, name, category, sell_price')
    .eq('in_stock', true)
    .order('category')
    .order('sku');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ products: data ?? [] });
}
