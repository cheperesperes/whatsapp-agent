import { NextResponse } from 'next/server';
import {
  deescalateConversation,
  escalateConversation,
  createServiceClient,
} from '@/lib/supabase';
import { sendHandoffAlert } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

// POST /api/conversations/[id]/action
// Body:
//   { action: 'deescalate' }
//   { action: 'close' }
//   { action: 'escalate', reason?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
  };
  const action = body?.action;

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

  if (action === 'escalate') {
    const supabase = createServiceClient();
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, phone_number')
      .eq('id', id)
      .maybeSingle();
    if (convErr || !conv) {
      return NextResponse.json(
        { error: convErr?.message ?? 'conversation not found' },
        { status: 404 }
      );
    }

    // Best-effort: pull last user message so the operator alert has context.
    const { data: lastUserMsg } = await supabase
      .from('messages')
      .select('content')
      .eq('conversation_id', id)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const reason = body.reason?.trim() || 'Operador solicitó tomar control desde el dashboard';
    const lastText = lastUserMsg?.content ?? '(sin mensaje del cliente)';

    await escalateConversation(id, reason, lastText);

    // Fire the WhatsApp alert to the operator. Don't fail the API call if
    // Twilio hiccups — the DB flag is what gates Sol's replies.
    try {
      await sendHandoffAlert(OPERATOR_PHONE, conv.phone_number, reason, lastText);
    } catch (err) {
      console.warn(
        '[action/escalate] handoff alert failed:',
        err instanceof Error ? err.message : err
      );
      return NextResponse.json({
        ok: true,
        warning: 'Conversation marked escalated, but operator WhatsApp alert failed.',
      });
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
