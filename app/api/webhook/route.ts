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
} from '@/lib/supabase';
import { generateSolResponse } from '@/lib/anthropic';
import {
  sendWhatsAppMessage,
  sendHandoffAlert,
  sendEscalatedMessageAlert,
  parseIncomingMessage,
  parseOwnerCommand,
} from '@/lib/whatsapp';

// ── Rate limiting: per-phone debounce ──────────────────────
const processingPhones = new Set<string>();
const RATE_LIMIT_MS = 3000; // 3 seconds

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

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
      // Convert FormData to plain object
      for (const [key, value] of formData.entries()) {
        body[key] = String(value);
      }
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
    return new NextResponse('<Response></Response>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }

  // Use waitUntil to keep the serverless function alive for background processing
  // This returns 200 immediately to Twilio while continuing to process the message
  waitUntil(
    processWebhook(body).catch((err) => {
      console.error('[WEBHOOK POST] Processing error:', err);
    })
  );

  return new NextResponse('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
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

  const { senderPhone, senderName, messageText, messageType, messageId } = parsed;

  console.log(`[WEBHOOK] Message from ${senderPhone} | type: ${messageType} | text: "${messageText.slice(0, 80)}"`);

  // ── Operator commands ───────────────────────────────────
  // Normalize phone numbers for comparison (remove non-digits)
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
    await sendWhatsAppMessage(
      senderPhone,
      'Por ahora solo puedo leer mensajes de texto. ¿Podría escribirme su pregunta?'
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

  // ── Store user message ──────────────────────────────────
  await storeMessage(conversation.id, 'user', messageText);

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

    // Remove the last message we just stored (we pass it separately)
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

      // Store assistant response (with handoff flag)
      await storeMessage(conversation.id, 'assistant', aiMessage, true);

      // Send customer-facing message (tag already stripped)
      await sendWhatsAppMessage(senderPhone, aiMessage);

      // Alert operator
      await sendHandoffAlert(OPERATOR_PHONE, senderPhone, handoffReason, messageText);
    } else {
      // ── Normal AI response ──────────────────────────────
      await storeMessage(conversation.id, 'assistant', aiMessage);
      await sendWhatsAppMessage(senderPhone, aiMessage);
    }

    // Remove from rate limit map early (processing done)
    processingPhones.delete(senderPhone);

  } catch (err) {
    console.error(`[WEBHOOK] AI error for ${senderPhone}:`, err);
    processingPhones.delete(senderPhone);

    // Graceful fallback message to customer
    await sendWhatsAppMessage(
      senderPhone,
      'Lo siento, tuve un problema técnico. Por favor intente de nuevo en un momento. Si el problema persiste, un especialista le contactará pronto.'
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
        targetPhone,
        'Hola, vuelve a estar con Sol 🌟 ¿En qué más le puedo ayudar?'
      );
      break;
    }

    case 'teach': {
      // /teach pregunta | respuesta
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
      // Future: implement broadcast to all active conversations
      await sendWhatsAppMessage(operatorPhone, '⚠️ Broadcast no implementado aún. Próximamente.');
      break;
    }

    default:
      await sendWhatsAppMessage(operatorPhone, `❓ Comando desconocido: /${command}`);
  }
}
