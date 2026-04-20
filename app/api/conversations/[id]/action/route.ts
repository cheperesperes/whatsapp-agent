import { NextResponse } from 'next/server';
import {
  deescalateConversation,
  escalateConversation,
  createServiceClient,
  storeMessage,
} from '@/lib/supabase';
import { sendHandoffAlert, sendMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

const DEFAULT_RESUME_MESSAGE =
  'Hola, vuelve a estar con Sol 🌟 ¿En qué más le puedo ayudar?';

// POST /api/conversations/[id]/action
// Body:
//   { action: 'deescalate', resumeMessage?: string, suppressResumeMessage?: boolean }
//   { action: 'close' }
//   { action: 'escalate', reason?: string }
//
// `deescalate` puts the conversation back in AI mode AND sends a short
// re-engagement message to the customer by default — without it the customer
// sees radio silence after a real handoff (they replied, we marked it resolved
// internally, but from their side nothing happened). The operator can pass
// `suppressResumeMessage: true` to de-escalate silently (e.g. when they just
// sent their own closing text through /send), or `resumeMessage` to customize.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
    resumeMessage?: string;
    suppressResumeMessage?: boolean;
  };
  const action = body?.action;

  if (action === 'deescalate') {
    const supabase = createServiceClient();
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, phone_number, escalated')
      .eq('id', id)
      .maybeSingle();
    if (convErr || !conv) {
      return NextResponse.json(
        { error: convErr?.message ?? 'conversation not found' },
        { status: 404 }
      );
    }

    // Flip the DB flags first — source of truth for the webhook's escalation
    // gate. If the follow-up WhatsApp send fails, Sol will still respond on
    // the customer's next message (the flag is what matters).
    await deescalateConversation(id);

    const suppress = body.suppressResumeMessage === true;
    if (suppress) {
      return NextResponse.json({ ok: true, resumeMessageSent: false });
    }

    const resumeMessage =
      (typeof body.resumeMessage === 'string' && body.resumeMessage.trim()) ||
      DEFAULT_RESUME_MESSAGE;

    try {
      await sendMessage(conv.phone_number, resumeMessage, 'whatsapp');
      await storeMessage(id, 'assistant', resumeMessage, false);
    } catch (err) {
      console.warn(
        `[action/deescalate] resume message send failed for conv=${id}:`,
        err instanceof Error ? err.message : err
      );
      return NextResponse.json({
        ok: true,
        resumeMessageSent: false,
        warning:
          'Conversation de-escalated, but re-engagement message failed to send.',
      });
    }

    return NextResponse.json({ ok: true, resumeMessageSent: true });
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
