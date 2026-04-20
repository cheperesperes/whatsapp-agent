import { NextResponse } from 'next/server';
import {
  createServiceClient,
  escalateConversation,
  storeMessage,
  OPERATOR_REPLY_REASON,
} from '@/lib/supabase';
import { sendMessage } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 1500;

// POST /api/conversations/[id]/send
// Body: { text: string, escalate?: boolean }
//
// Send a text from the operator (via the dashboard) directly to the customer.
// Stored as an assistant-role message so it shows up in the same thread as
// Sol's replies. If `escalate` is true (default), the conversation is also
// flipped into 'escalated' state so Sol stops auto-replying.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    escalate?: boolean;
  };

  const text = (body.text ?? '').trim();
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_BODY_CHARS} chars` },
      { status: 400 }
    );
  }

  const shouldEscalate = body.escalate !== false; // default: true

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

  // Send via Twilio first — if the carrier rejects, surface the error
  // immediately. Only persist the message after a successful send so the
  // dashboard never shows a "sent" message that didn't actually leave.
  try {
    await sendMessage(conv.phone_number, text, 'whatsapp');
  } catch (err) {
    console.error(
      '[send] Twilio failed | conv=' + id + ':',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'send failed' },
      { status: 502 }
    );
  }

  await storeMessage(id, 'assistant', text, false);

  // Use the OPERATOR_REPLY_REASON sentinel — the webhook recognizes this and
  // auto-resumes Sol on the customer's next reply, so a one-off operator text
  // doesn't permanently take Sol offline. Real "take over" handoffs use a
  // different reason and stay escalated until manually de-escalated.
  if (shouldEscalate && !conv.escalated) {
    await escalateConversation(id, OPERATOR_REPLY_REASON, text);
  }

  return NextResponse.json({ ok: true, escalated: shouldEscalate });
}
