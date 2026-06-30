import { NextResponse } from 'next/server';
import {
  createServiceClient,
  escalateConversation,
  deescalateConversation,
  storeMessage,
  OPERATOR_REPLY_REASON,
} from '@/lib/supabase';
import { sendMessage, sendImage } from '@/lib/whatsapp';
import { getProductImages } from '@/lib/supabase';

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
    imageUrl?: string;   // optional: send a product image (free-form, 24h window)
    imageSku?: string;   // optional: resolve the product image by SKU from the catalog
  };

  const text = (body.text ?? '').trim();
  if (!text && !body.imageUrl && !body.imageSku) {
    return NextResponse.json({ error: 'text or image is required' }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_BODY_CHARS} chars` },
      { status: 400 }
    );
  }

  const explicitTakeover = body.escalate === true; // opt-in only; default = auto-return to Sol

  const supabase = createServiceClient();
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('id, phone_number, escalated, channel, escalation_reason')
    .eq('id', id)
    .maybeSingle();
  if (convErr || !conv) {
    return NextResponse.json(
      { error: convErr?.message ?? 'conversation not found' },
      { status: 404 }
    );
  }

  // A WhatsApp send needs a real phone. Web-widget visitors have none (they're
  // keyed by session id), so a manual WhatsApp reply can't reach them — return
  // a clear 400 instead of crashing on null.startsWith() inside the sender.
  if (!conv.phone_number) {
    return NextResponse.json(
      {
        error:
          conv.channel === 'web'
            ? 'Esta conversación es del chat web (sin número de WhatsApp). Respóndele desde el widget del sitio, no por WhatsApp.'
            : 'Esta conversación no tiene número de teléfono registrado, no se puede enviar por WhatsApp.',
      },
      { status: 400 }
    );
  }

  // Resolve an optional image: explicit imageUrl wins, else look up by SKU.
  let imageUrl: string | null = body.imageUrl?.trim() || null;
  if (!imageUrl && body.imageSku) {
    const urls = await getProductImages(body.imageSku.trim(), 1);
    imageUrl = urls[0] ?? null;
  }

  // Send via Meta first — if it rejects, surface the error immediately.
  // Only persist the message after a successful send so the dashboard
  // never shows a "sent" message that didn't actually leave.
  try {
    if (text) await sendMessage(conv.phone_number, text, 'whatsapp');
    if (imageUrl) await sendImage(conv.phone_number, imageUrl, undefined, 'whatsapp');
  } catch (err) {
    console.error(
      '[send] WhatsApp send failed | conv=' + id + ':',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'send failed' },
      { status: 502 }
    );
  }

  // Persist after a successful send, wrapped so a DB hiccup AFTER the message
  // already left Meta can't 500 the route — a 500 makes the operator re-click
  // Send and deliver the same WhatsApp message to the customer twice.
  try {
    await storeMessage(id, 'assistant', text || (imageUrl ? '[imagen del producto]' : ''), false);
  } catch (e) {
    console.error('[send] persist-after-send failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  // AUTO-RETURN to Sol after a one-off operator text (Ed 2026-06-29). The operator's
  // message is sent + recorded as an assistant turn; Sol keeps ownership and handles
  // the customer's next reply — no manual "Devolver a Sol" is needed, so a lead can't
  // be orphaned by a forgotten hand-back. A REAL takeover (escalated via "Escalar a
  // operador" with any reason other than OPERATOR_REPLY_REASON) is left escalated so the
  // operator keeps the floor; an explicit { escalate: true } still parks the chat (opt-in).
  if (explicitTakeover) {
    if (!conv.escalated) await escalateConversation(id, OPERATOR_REPLY_REASON, '');
    return NextResponse.json({ ok: true, escalated: true });
  }
  const inRealTakeover =
    conv.escalated && conv.escalation_reason !== OPERATOR_REPLY_REASON;
  if (conv.escalated && !inRealTakeover) {
    await deescalateConversation(id); // hand a prior operator-parked chat back to Sol
  }
  return NextResponse.json({ ok: true, escalated: inRealTakeover, autoReturned: !inRealTakeover });
}
