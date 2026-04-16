import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

// Always process webhook requests dynamically — never cache
export const dynamic = 'force-dynamic';
import {
  getOrCreateConversation,
  loadRecentMessages,
  storeMessage,
  escalateConversation,
  deescalateConversation,
  getConversationByPhone,
  loadAgentCatalog,
  formatProductCatalogForPrompt,
  getDashboardStats,
  loadKnowledgeBase,
  formatKnowledgeBaseForPrompt,
  addKnowledgeEntry,
  hasProcessedMessageSid,
  countRecentUserMessagesFromPhone,
  optOutConversation,
} from '@/lib/supabase';
import { generateSolResponse } from '@/lib/anthropic';
import {
  sendWhatsAppMessage,
  sendMessage,
  sendHandoffAlert,
  sendEscalatedMessageAlert,
  parseIncomingMessage,
  parseOwnerCommand,
} from '@/lib/whatsapp';
import { verifyTwilioSignature } from '@/lib/twilio-signature';

// ── Rate limiting: per-phone debounce ──────────────────────
const processingPhones = new Set<string>();
const RATE_LIMIT_MS = 3000; // 3 seconds

// Rolling-hour hard cap per phone (abuse guard)
const HOURLY_MESSAGE_CAP = Number(process.env.HOURLY_MESSAGE_CAP ?? 40);

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

// Allow signature verification to be disabled ONLY via explicit env flag,
// so local/dev can post without Twilio headers. Production must not set this.
const SKIP_SIG_VERIFY = process.env.SKIP_TWILIO_SIGNATURE === '1';

// Opt-out keywords (case-insensitive, whole message or substring match)
const OPT_OUT_KEYWORDS_EXACT = new Set([
  'stop', 'baja', 'cancelar', 'cancel', 'unsubscribe', 'desuscribir',
  'salir', 'para', 'quit', 'optout',
]);
const OPT_OUT_KEYWORDS_CONTAINS = [
  'opt out', 'opt-out', 'no mas mensajes', 'no más mensajes',
  'no me escribas', 'no me escriban', 'no quiero recibir mensajes', 'darme de baja',
];

// ============================================================
// GET — Webhook Verification
// ============================================================
export async function GET(request: NextRequest) {
  console.log('[WEBHOOK GET] Verification request received');

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  console.log('[WEBHOOK GET] mode:', mode, '| token match:', token === process.env.WHATSAPP_VERIFY_TOKEN);

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WEBHOOK GET] Verification successful, returning challenge');
    return new NextResponse(challenge, { status: 200 });
  }

  console.log('[WEBHOOK GET] Verification failed — token mismatch');
  return new NextResponse('Forbidden', { status: 403 });
}

// ============================================================
// POST — Incoming Messages
// ============================================================
export async function POST(request: NextRequest) {
  console.log('[WEBHOOK POST] Incoming webhook payload received');

  // Parse form-urlencoded body from Twilio
  const contentType = request.headers.get('content-type') || '';
  let body: Record<string, string> = {};

  if (contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const formData = await request.formData();
      for (const [key, value] of formData.entries()) body[key] = String(value);
    } catch {
      console.warn('[WEBHOOK POST] Failed to parse form data');
    }
  } else if (contentType.includes('application/json')) {
    try {
      body = await request.json();
    } catch {
      console.warn('[WEBHOOK POST] Failed to parse JSON');
    }
  }

  if (!body || Object.keys(body).length === 0) {
    return twimlOk();
  }

  // ── Signature verification (rejects spoofed posts) ────────────────
  if (!SKIP_SIG_VERIFY) {
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? '';
    const sigHeader = request.headers.get('x-twilio-signature');

    const candidates = buildSignatureUrlCandidates(request);
    let ok = false;
    let matchedUrl = '';
    for (const candidate of candidates) {
      if (verifyTwilioSignature(authToken, sigHeader, candidate, body)) {
        ok = true;
        matchedUrl = candidate;
        break;
      }
    }

    if (!ok) {
      console.warn(
        '[WEBHOOK POST] Signature mismatch — rejecting. Tried URLs:',
        candidates,
        '| hasAuthToken:',
        Boolean(authToken),
        '| hasSigHeader:',
        Boolean(sigHeader)
      );
      return new NextResponse('Forbidden', { status: 403 });
    }

    console.log('[WEBHOOK POST] Signature OK (matched URL:', matchedUrl, ')');
  } else {
    console.log('[WEBHOOK POST] SKIP_TWILIO_SIGNATURE=1 — verification bypassed');
  }

  // ── Idempotency: short-circuit Twilio retries for the same MessageSid ──
  const sid = body.MessageSid;
  if (sid && (await hasProcessedMessageSid(sid))) {
    console.log(`[WEBHOOK POST] Duplicate MessageSid ${sid} — ack without reprocess`);
    return twimlOk();
  }

  waitUntil(
    processWebhook(body).catch((err) => {
      console.error('[WEBHOOK POST] Processing error:', err);
    })
  );

  return twimlOk();
}

function twimlOk() {
  return new NextResponse('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function buildSignatureUrlCandidates(request: NextRequest): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    if (!u) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  add(request.url);

  const xfProto = request.headers.get('x-forwarded-proto');
  const xfHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (xfHost) {
    try {
      const u = new URL(request.url);
      const path = u.pathname + (u.search || '');
      add(`https://${xfHost}${path}`);
      add(`http://${xfHost}${path}`);
      if (xfProto) add(`${xfProto}://${xfHost}${path}`);
    } catch {
      // ignore
    }
  }

  const withSlashToggled = out.flatMap((u) => {
    try {
      const parsed = new URL(u);
      const p = parsed.pathname;
      if (p.endsWith('/')) {
        return [u, u.replace(p, p.slice(0, -1))];
      } else {
        return [u, u.replace(p, p + '/')];
      }
    } catch {
      return [u];
    }
  });

  const final: string[] = [];
  const seenFinal = new Set<string>();
  for (const u of withSlashToggled) {
    if (!seenFinal.has(u)) {
      seenFinal.add(u);
      final.push(u);
    }
  }
  return final;
}

// ============================================================
// Core processing logic
// ============================================================
async function processWebhook(body: unknown) {
  const parsed = parseIncomingMessage(body);

  if (!parsed) {
    console.log('[WEBHOOK] No parseable message in payload (status update?)');
    return;
  }

  const { senderPhone: rawSenderPhone, senderName, messageText, messageType, messageId, channel } = parsed;
  const senderPhone = rawSenderPhone.startsWith('+')
    ? '+' + rawSenderPhone.slice(1).replace(/[^\d]/g, '')
    : '+' + rawSenderPhone.replace(/[^\d]/g, '');

  console.log(`[WEBHOOK] Message from ${senderPhone} | channel: ${channel} | type: ${messageType} | text: "${messageText.slice(0, 80)}"`);

  // ── Operator commands ───────────────────────────────────
  const normalizedOperatorPhone = OPERATOR_PHONE.replace(/\D/g, '');
  const normalizedSenderPhone = senderPhone.replace(/\D/g, '');

  if (normalizedSenderPhone === normalizedOperatorPhone) {
    const command = parseOwnerCommand(messageText);
    if (command) {
      await handleOwnerCommand(command.command, command.args, senderPhone);
      return;
    }
  }

  // ── Non-text messages ───────────────────────────────────
  if (messageType !== 'text' || !messageText.trim()) {
    await sendMessage(
      senderPhone,
      'Por ahora solo puedo leer mensajes de texto. ¿Podría escribirme su pregunta?',
      channel
    );
    return;
  }

  // ── Rate limiting ───────────────────────────────────────
  if (processingPhones.has(senderPhone)) {
    console.log(`[WEBHOOK] Rate limit: skipping ${senderPhone} (already processing)`);
    return;
  }

  processingPhones.add(senderPhone);
  setTimeout(() => processingPhones.delete(senderPhone), RATE_LIMIT_MS);

  // ── Conversation setup ──────────────────────────────────
  const conversation = await getOrCreateConversation(senderPhone, senderName ?? undefined);

  // ── Opted-out guard ────────────────────────────────────────
  // If customer previously opted out, treat new message as re-enrollment.
  if (conversation.opted_out === true) {
    console.log(`[WEBHOOK] ${senderPhone} previously opted out — re-enrolling on new message`);
    const { createServiceClient } = (await import('@/lib/supabase'));
    await createServiceClient().from('conversations').update({
      opted_out: false,
      opted_out_at: null,
      status: 'active',
      escalation_reason: null,
      updated_at: new Date().toISOString(),
    }).eq('id', conversation.id);
    conversation.opted_out = false;
    // Continue processing — Sol will greet them as a new customer
  }

  // ── Hourly abuse cap (per phone) ─────────────────────────
  const recentCount = await countRecentUserMessagesFromPhone(senderPhone, 60);
  if (recentCount >= HOURLY_MESSAGE_CAP) {
    console.warn(`[WEBHOOK] Rate cap hit for ${senderPhone}: ${recentCount} msgs in last hour`);
    await storeMessage(conversation.id, 'user', messageText, false, messageId);
    if (recentCount === HOURLY_MESSAGE_CAP) {
      await sendMessage(
        senderPhone,
        'Ha alcanzado el límite de mensajes por hora. Un especialista le contactará pronto si es urgente.',
        channel
      );
      await sendHandoffAlert(OPERATOR_PHONE, senderPhone, 'rate_cap_exceeded', messageText);
      await escalateConversation(conversation.id, 'rate_cap_exceeded', messageText);
    }
    processingPhones.delete(senderPhone);
    return;
  }

  // ── Store user message (idempotent on MessageSid) ────────
  try {
    await storeMessage(conversation.id, 'user', messageText, false, messageId);
    console.log(`[WEBHOOK] Stored inbound message | conv=${conversation.id} | sid=${messageId}`);
  } catch (err) {
    console.error(`[WEBHOOK] storeMessage FAILED | conv=${conversation.id} | sid=${messageId}:`, err);
    throw err;
  }

  // ── Opt-out keywords (STOP, BAJA, CANCELAR, …) ───────────
  const trimmed = messageText.trim().toLowerCase();
  const isOptOut =
    OPT_OUT_KEYWORDS_EXACT.has(trimmed) ||
    OPT_OUT_KEYWORDS_CONTAINS.some((kw) => trimmed.includes(kw));

  if (isOptOut) {
    console.log(`[WEBHOOK] Opt-out from ${senderPhone}`);
    await optOutConversation(conversation.id);

    // Detect language from message content
    const isEnglish = /^[a-z\s\-]+$/.test(trimmed) && !trimmed.match(/[áéíóúñ]/);
    const optOutMsg = isEnglish
      ? 'Done! You have been unsubscribed. You will not receive any more messages from Oiikon. If you ever want to reach us again, just send us a message and we will be happy to help. Have a great day! 😊'
      : 'Listo, le hemos dado de baja. No recibirá más mensajes de Oiikon. Si algún día desea volver a contactarnos, puede escribirnos aquí y con gusto le atendemos. ¡Que tenga un excelente día! 😊';

    await sendMessage(senderPhone, optOutMsg, channel);
    await sendHandoffAlert(OPERATOR_PHONE, senderPhone, 'user_opt_out', messageText);
    processingPhones.delete(senderPhone);
    return;
  }

  // ── Human mode: notify operator, skip AI ───────────────
  if (conversation.escalated) {
    console.log(`[WEBHOOK] Conversation ${senderPhone} is escalated — forwarding to operator`);
    await sendEscalatedMessageAlert(OPERATOR_PHONE, senderPhone, messageText);
    return;
  }

  // ── AI mode: generate Sol response ─────────────────────
  try {
    const [history, products, knowledgeEntries] = await Promise.all([
      loadRecentMessages(conversation.id, 20),
      loadAgentCatalog(),
      loadKnowledgeBase(),
    ]);

    const historyWithoutLast = history.slice(0, -1);

    const catalog = formatProductCatalogForPrompt(products);
    const kbPrompt = formatKnowledgeBaseForPrompt(knowledgeEntries);
    const { message: aiMessage, handoffReason } = await generateSolResponse(
      historyWithoutLast,
      messageText,
      catalog,
      kbPrompt
    );

    // ── Handle HANDOFF ───────────────────────────────────
    if (handoffReason) {
      console.log(`[WEBHOOK] Handoff detected for ${senderPhone}: ${handoffReason}`);
      await escalateConversation(conversation.id, handoffReason, messageText);
      await storeMessage(conversation.id, 'assistant', aiMessage, true);
      await sendMessage(senderPhone, aiMessage, channel);
      await sendHandoffAlert(OPERATOR_PHONE, senderPhone, handoffReason, messageText);
    } else {
      // ── Normal AI response ──────────────────────────────
      await storeMessage(conversation.id, 'assistant', aiMessage);
      await sendMessage(senderPhone, aiMessage, channel);
    }

    processingPhones.delete(senderPhone);

  } catch (err) {
    console.error(`[WEBHOOK] AI error for ${senderPhone}:`, err);
    processingPhones.delete(senderPhone);
    await sendMessage(
      senderPhone,
      'Lo siento, tuve un problema técnico. Por favor intente de nuevo en un momento. Si el problema persiste, un especialista le contactará pronto.',
      channel
    );
  }
}

// ============================================================
// Owner command handlers
// ============================================================
async function handleOwnerCommand(command: string, args: string, operatorPhone: string) {
  console.log(`[OWNER CMD] /${command} ${args}`);

  switch (command) {
    case 'status': {
      const stats = await getDashboardStats();
      const msg = [
        '📊 Estado de Oiikon Sol',
        `Total conversaciones: ${stats.total_conversations}`,
        `Activas: ${stats.active_conversations}`,
        `Escaladas: ${stats.escalated_conversations}`,
        `Cerradas: ${stats.closed_conversations}`,
        `Mensajes hoy: ${stats.messages_today}`,
      ].join('\n');
      await sendWhatsAppMessage(operatorPhone, msg);
      break;
    }

    case 'bot': {
      const targetPhone = args.replace(/\D/g, '');
      const conv = await getConversationByPhone(targetPhone);

      if (!conv) {
        await sendWhatsAppMessage(operatorPhone, `❌ No encontré conversación con ${args}`);
        return;
      }

      if (!conv.escalated) {
        await sendWhatsAppMessage(operatorPhone, `ℹ️ ${args} ya está en modo AI.`);
        return;
      }

      await deescalateConversation(conv.id);
      await sendWhatsAppMessage(operatorPhone, `✅ ${args} devuelto a Sol (modo AI).`);
      await sendWhatsAppMessage(
        conv.phone_number,
        'Hola, vuelve a estar con Sol 🌟 ¿En qué más le puedo ayudar?'
      );
      break;
    }

    case 'teach': {
      const separator = args.indexOf('|');
      if (separator === -1) {
        await sendWhatsAppMessage(
          operatorPhone,
          '⚠️ Formato: /teach pregunta | respuesta\nEjemplo: /teach ¿Cuánto tarda el envío a Cuba? | El envío a Cuba tarda entre 2-4 semanas.'
        );
        return;
      }
      const question = args.slice(0, separator).trim();
      const answer = args.slice(separator + 1).trim();

      if (!question || !answer) {
        await sendWhatsAppMessage(operatorPhone, '⚠️ Tanto la pregunta como la respuesta son requeridas.');
        return;
      }

      const entry = await addKnowledgeEntry(question, answer);
      if (entry) {
        await sendWhatsAppMessage(operatorPhone, `✅ Sol aprendió:\nP: ${question}\nR: ${answer}`);
      } else {
        await sendWhatsAppMessage(operatorPhone, '❌ Error guardando la entrada. Intente de nuevo.');
      }
      break;
    }

    case 'broadcast': {
      await sendWhatsAppMessage(operatorPhone, '⚠️ Broadcast no implementado aún. Próximamente.');
      break;
    }

    default:
      await sendWhatsAppMessage(operatorPhone, `❓ Comando desconocido: /${command}`);
  }
}
