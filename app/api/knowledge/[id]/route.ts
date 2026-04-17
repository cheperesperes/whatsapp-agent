import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// PATCH /api/knowledge/[id] — update question/answer/category
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body?.question === 'string') patch.question = body.question.trim();
  if (typeof body?.answer === 'string') patch.answer = body.answer.trim();
  if (typeof body?.category === 'string') patch.category = body.category.trim();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('knowledge_base')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS });
  }
  return NextResponse.json({ entry: data }, { headers: NO_CACHE_HEADERS });
}

// DELETE /api/knowledge/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = createServiceClient();
  const { error } = await supabase.from('knowledge_base').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS });
  }
  return NextResponse.json({ ok: true }, { headers: NO_CACHE_HEADERS });
}
