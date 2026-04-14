import { NextResponse } from 'next/server';
import { deescalateConversation, createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// POST /api/conversations/[id]/action
// Body: { action: 'deescalate' | 'close' }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string | undefined;

  if (action === 'deescalate') {
    await deescalateConversation(id);
    return NextResponse.json({ ok: true });
  }

  if (action === 'close') {
    const supabase = createServiceClient();
    const { error } = await supabase
      .from('conversations')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
