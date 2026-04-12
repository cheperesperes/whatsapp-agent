import { NextRequest, NextResponse } from 'next/server';

// Always process webhook requests dynamically — never cache
export const dynamic = 'force-dynamic';
import {
  getOrCreateConversation,
  loadRecentMessages,
  storeMessage,
  escalateConversation,
  deescalateConversation,
  getConversationByPhone,
  loadProducts,
  formatProductCatalogForPrompt,
  getDashboardStats,
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

  // Always return 200 immediately to Meta (avoid retries)
  const body = await request.json().catch(() => null);

  if (!body) {
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }

  // Process asynchronously — don't await (Meta expects fast 200)
  processWebhook(body).catch((err) => {
    console.error('[WEBHOOK POST] Processing error:', err);
  });

  return NextResponse.json({ status: 'ok' }, { status: 200 });
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
  if (senderPhone === OPERATOR_PHONE.replace(/\D/g, '')) {
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
    const [history, products] = await Promise.all([
      loadRecentMessages(conversation.id, 20),
      loadProducts(),
    ]);

    // Remove the last message we just stored (we pass it separately)
    const historyWithoutLast = history.slice(0, -1);

    const catalog = formatProductCatalogForPrompt(products);
    const { message: aiMessage, handoffReason } = await generateSolResponse(
      historyWithoutLast,
      messageText,
      catalog
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

    case 'broadcast': {
      // Future: implement broadcast to all active conversations
      await sendWhatsAppMessage(operatorPhone, '⚠️ Broadcast no implementado aún. Próximamente.');
      break;
    }

    default:
      await sendWhatsAppMessage(operatorPhone, `❓ Comando desconocido: /${command}`);
  }
}
