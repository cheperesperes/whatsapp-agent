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
  loadCustomerProfile,
  upsertCustomerProfile,
  formatCustomerProfileForPrompt,
  createKBSuggestion,
  getProductImages,
  getRecentDispatchedSkus,
  recordDispatchedSkus,
  upsertLeadScore,
  markConversationWon,
  getConversationByAnyPhone,
  OPERATOR_REPLY_REASON,
} from '@/lib/supabase';
import {
  generateSolResponse,
  extractCustomerFacts,
  extractKBSuggestions,
  scoreLeadQuality,
  mergeReading,
  buildDynamicDirectives,
} from '@/lib/anthropic';
import { classifyIntent, formatIntentHintForPrompt } from '@/lib/classifier';
import { loadCompetitorModels, formatCompetitorsForPrompt } from '@/lib/competitors';
import { normalizeWhatsAppFormatting } from '@/lib/whatsapp-format';
import {
  detectLanguageFromHistory,
  formatLanguageLockForPrompt,
} from '@/lib/language';
import { buildFirstContactDirective } from '@/lib/ad-landing';
import { timezoneFromPhone } from '@/lib/timezone';
import {
  sendWhatsAppMessage,
  sendMessage,
  sendImage,
  sendHandoffAlert,
  sendEscalatedMessageAlert,
  parseIncomingMessage,
  parseOwnerCommand,
} from '@/lib/whatsapp';
import { verifyTwilioSignature } from '@/lib/twilio-signature';
import type { CustomerProfile, Message } from '@/lib/types';

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
  // EXCEPTION: if the operator just sent a one-off text from the dashboard
  // (escalation_reason === OPERATOR_REPLY_REASON), AUTO-RESUME Sol on the
  // customer's reply so the conversation flows naturally. Real handoffs
  // (objection, opt-out, manual escalation) stay escalated.
  if (conversation.escalated) {
    if (conversation.escalation_reason === OPERATOR_REPLY_REASON) {
      console.log(
        `[WEBHOOK] Customer ${senderPhone} replied after operator text — auto-resuming Sol`
      );
      await deescalateConversation(conversation.id);
      // Refresh local view so downstream code (e.g. AI flow) sees post-resume state.
      conversation.escalated = false;
      conversation.escalation_reason = null;
      conversation.status = 'active';
      // Fall through to the AI flow below.
    } else {
      console.log(`[WEBHOOK] Conversation ${senderPhone} is escalated — forwarding to operator`);
      await sendEscalatedMessageAlert(OPERATOR_PHONE, senderPhone, messageText);
      return;
    }
  }

  // ── AI mode: generate Sol response ─────────────────────
  try {
    const [history, products, knowledgeEntries, customerProfile, alreadySentSkus, competitors] = await Promise.all([
      loadRecentMessages(conversation.id, 20),
      loadAgentCatalog(),
      loadKnowledgeBase(),
      loadCustomerProfile(senderPhone),
      getRecentDispatchedSkus(conversation.id),
      loadCompetitorModels(),
    ]);

    const historyWithoutLast = history.slice(0, -1);

    const catalog = formatProductCatalogForPrompt(products);
    const kbPrompt = formatKnowledgeBaseForPrompt(knowledgeEntries);
    const profilePrompt = formatCustomerProfileForPrompt(customerProfile);
    const competitorPrompt = formatCompetitorsForPrompt(competitors, products);
    const dispatchedPrompt =
      alreadySentSkus.length > 0
        ? `\nFOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: [${alreadySentSkus.join(', ')}]\nNO incluyas [SEND_IMAGE:SKU] para estos SKUs — el cliente ya los tiene.\n`
        : '';

    // ── Classify intent (Haiku 4.5, ~400ms) — failures fall back to no hint ──
    const intent = await classifyIntent(historyWithoutLast, messageText);
    const intentHint = formatIntentHintForPrompt(intent);
    if (intent) {
      console.log(
        `[WEBHOOK] Intent for ${senderPhone}: stage=${intent.stage} prior_rec=${intent.prior_assistant_recommended} equipment=[${intent.equipment_mentioned.join(',')}]`
      );
    }

    // ── Deterministic language pinning ──────────────────────
    // Zero-cost heuristic over the last 5 user turns. Spanglish = Spanish
    // (we serve Cuban families). The resulting lock is injected at the
    // END of the system prompt so the model reads it last, as a hard
    // imperative. Catches the 17:20 ET prod bug where Sol replied in
    // English to "Hello! Que capacidad tiene...".
    const recentUserMsgs = [
      ...historyWithoutLast
        .filter((m) => m.role === 'user')
        .slice(-4)
        .map((m) => m.content),
      messageText,
    ];
    const detectedLang = detectLanguageFromHistory(
      recentUserMsgs,
      customerProfile?.language
    );
    const languageLock = formatLanguageLockForPrompt(detectedLang);
    console.log(
      `[WEBHOOK] Language pin for ${senderPhone}: ${detectedLang} (persisted=${customerProfile?.language ?? 'none'})`
    );
    // Persist the detection so subsequent turns inherit it as fallback
    // when the current message is SKU-only or emoji-only. Non-blocking.
    if (customerProfile?.language !== detectedLang) {
      waitUntil(
        upsertCustomerProfile(senderPhone, { language: detectedLang }).catch(
          (err) =>
            console.warn(
              `[WEBHOOK] language persist failed for ${senderPhone}:`,
              err
            )
        )
      );
    }

    // ── Turn-1 first-contact directive ──────────────────────
    // Most Oiikon customers arrive via Facebook ads whose WhatsApp CTA
    // pre-fills one of a handful of templates ("¿Qué productos ofrecen?",
    // "Hello! Can I get more info on this?", "Hola"). Without this block
    // Sol was treating those templates as real questions and dumping the
    // catalog on turn 1 — the opposite of what a trained salesperson does
    // with an ad-click lead. We check whether this is the very first turn
    // (historyWithoutLast is empty → the user message we're replying to is
    // their first ever) and, if so, inject a directive that routes Sol to
    // a warm greeting + ONE qualifying question. Detection is strict
    // (exact match after normalization) so real questions fall through to
    // the softer organic-first-contact directive that still forces an
    // intro but lets her answer the question.
    let firstContactDirective = '';
    if (historyWithoutLast.length === 0) {
      const built = buildFirstContactDirective(messageText, detectedLang);
      if (built) {
        firstContactDirective = built.directive;
        console.log(
          `[WEBHOOK] Turn-1 directive for ${senderPhone}: ` +
            (built.adMatch
              ? `ad_arrival variant=${built.adMatch.variant} language=${built.adMatch.language}`
              : `organic language=${detectedLang}`)
        );

        // Seed arrival_source into the structured read so later turns know
        // HOW the customer landed (ad vs organic). This is the only signal
        // that can't be recovered later from the transcript — once they've
        // exchanged a few messages, the ad opener is far up in the history
        // and Haiku would miss it. Seed it now, inline, as a merge so we
        // don't clobber anything else the Haiku extractor may have already
        // written.
        const arrivalSource = built.adMatch
          ? `facebook_ad:${built.adMatch.variant}`
          : 'organic';
        const seededReading = mergeReading(
          customerProfile?.reading ?? null,
          { arrival_source: arrivalSource },
          new Date().toISOString()
        );
        waitUntil(
          upsertCustomerProfile(senderPhone, { reading: seededReading }).catch(
            (err) =>
              console.warn(
                `[WEBHOOK] arrival_source seed failed for ${senderPhone}:`,
                err
              )
          )
        );
      }

      // Also seed user_timezone on turn 1 — derived from the phone country
      // code via timezoneFromPhone. This is BEFORE Haiku has had a chance to
      // extract anything, so the followup cron (which runs 18h later) has a
      // tz even for brand-new conversations. Skip if we already have one
      // stored (operator might have corrected it manually).
      if (!customerProfile?.user_timezone) {
        const seededTz = timezoneFromPhone(senderPhone);
        waitUntil(
          upsertCustomerProfile(senderPhone, { user_timezone: seededTz }).catch(
            (err) =>
              console.warn(
                `[WEBHOOK] user_timezone seed failed for ${senderPhone}:`,
                err
              )
          )
        );
        console.log(
          `[WEBHOOK] Seeded user_timezone=${seededTz} for ${senderPhone}`
        );
      }
    }

    // ── Per-turn dynamic directives ─────────────────────────
    // Computed from: how many user turns we've had, the latest reading,
    // and the raw text of this message. Emits a short block that tells
    // Sol to soft-close when the customer is ready, or to pivot once
    // before backing off when the customer rejects. Empty string when no
    // rule applies — the prompt assembly handles that gracefully.
    const userTurnCount =
      historyWithoutLast.filter((m) => m.role === 'user').length + 1; // +1 for current msg
    const dynamicDirectives = buildDynamicDirectives({
      userTurnCount,
      intentStage: customerProfile?.reading?.intent_stage ?? undefined,
      lastUserText: messageText,
    });
    if (dynamicDirectives) {
      console.log(
        `[WEBHOOK] Dynamic directives for ${senderPhone}: ` +
          `turnCount=${userTurnCount} ` +
          `stage=${customerProfile?.reading?.intent_stage ?? 'none'} ` +
          `rules=${dynamicDirectives.split('\n').length - 1}`
      );
    }

    const { message: aiMessage, handoffReason, metrics } = await generateSolResponse(
      historyWithoutLast,
      messageText,
      catalog,
      kbPrompt,
      profilePrompt + dispatchedPrompt,
      intentHint,
      competitorPrompt,
      languageLock,
      firstContactDirective,
      dynamicDirectives
    );

    // ── Funnel metrics — log for analytics (not sent to customer) ──
    // Internal tags `[METRIC: ...]` are already stripped from `aiMessage`.
    if (metrics.length > 0) {
      console.log(
        `[METRICS] ${senderPhone} conv=${conversation.id}: ${metrics.join(' | ')}`
      );
    }

    // ── Extract [SEND_IMAGE:SKU] tags, strip duplicates already sent ──
    const { text: extractedMessage, skus: rawSkus } = extractImageTags(aiMessage);
    const sentSet = new Set(alreadySentSkus);
    const imageSkus = rawSkus.filter((s) => !sentSet.has(s.toUpperCase()));

    // ── Last-line-of-defense: normalize WhatsApp formatting ─────
    // Deterministic cleanup for the 3 patterns that render as literal broken
    // code when the prompt drifts (`**bold**` → `*bold*`, `~~strike~~` →
    // `~strike~`) plus table detection for observability. Runs for every
    // outbound message so the customer never sees a visible `**`.
    const { text: cleanMessage, fixes: formatFixes } =
      normalizeWhatsAppFormatting(extractedMessage);
    if (formatFixes.length > 0) {
      console.warn(
        `[WEBHOOK] Format fixes applied for ${senderPhone} conv=${conversation.id}: ${formatFixes.join(',')}`
      );
    }

    // ── Handle HANDOFF ───────────────────────────────────
    if (handoffReason) {
      console.log(`[WEBHOOK] Handoff detected for ${senderPhone}: ${handoffReason}`);
      await escalateConversation(conversation.id, handoffReason, messageText);
      await storeMessage(conversation.id, 'assistant', cleanMessage, true);
      await sendMessage(senderPhone, cleanMessage, channel);
      await sendHandoffAlert(OPERATOR_PHONE, senderPhone, handoffReason, messageText);
    } else {
      // ── Normal AI response ──────────────────────────────
      await storeMessage(conversation.id, 'assistant', cleanMessage);
      await sendMessage(senderPhone, cleanMessage, channel);

      // ── Dispatch product images (WhatsApp only, best-effort) ──
      if (channel === 'whatsapp' && imageSkus.length > 0) {
        waitUntil(
          dispatchProductImages(senderPhone, imageSkus)
            .then(() => recordDispatchedSkus(conversation.id, imageSkus))
            .catch((err) => console.warn('[WEBHOOK] image dispatch failed:', err))
        );
      }
    }

    // ── Background learning: profile facts + KB suggestions ─
    const fullHistory = [
      ...history,
      { id: '', conversation_id: conversation.id, role: 'assistant' as const, content: cleanMessage, handoff_detected: !!handoffReason, created_at: new Date().toISOString() },
    ];
    waitUntil(
      runBackgroundLearning(conversation.id, senderPhone, fullHistory, customerProfile).catch((err) =>
        console.warn('[learning] background job failed:', err)
      )
    );

    processingPhones.delete(senderPhone);

  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'APIConnectionTimeoutError' ||
        err.message.toLowerCase().includes('timeout') ||
        err.message.toLowerCase().includes('timed out'));
    console.error(
      `[WEBHOOK] AI error for ${senderPhone} (timeout=${isTimeout}):`,
      err
    );
    processingPhones.delete(senderPhone);
    const fallback = isTimeout
      ? 'Estoy tardando más de lo normal en responder. ¿Podría repetir su mensaje? Si persiste, un especialista le contactará.'
      : 'Lo siento, tuve un problema técnico. Por favor intente de nuevo en un momento. Si el problema persiste, un especialista le contactará pronto.';
    try {
      await sendMessage(senderPhone, fallback, channel);
    } catch (sendErr) {
      console.error(`[WEBHOOK] fallback sendMessage failed for ${senderPhone}:`, sendErr);
    }
  }
}

// ============================================================
// Background learning (customer profile + KB suggestions)
// ============================================================
async function runBackgroundLearning(
  conversationId: string,
  phone: string,
  history: Message[],
  existingProfile: CustomerProfile | null
) {
  // Allow extraction from the very first [user, assistant] pair so turn 2
  // inherits a `reading` from turn 1. Lead-scoring still needs more
  // context and gates itself internally (scoreLeadQuality checks its own
  // history length), as does KB-suggestion extraction.
  if (history.length < 2) return;

  const [facts, suggestions, leadScore] = await Promise.all([
    extractCustomerFacts(history, existingProfile),
    extractKBSuggestions(history),
    scoreLeadQuality(history),
  ]);

  if (facts) {
    // `language` is intentionally NOT written here — the deterministic
    // heuristic in the main webhook path owns it. Letting Haiku override
    // would re-introduce the exact drift that caused the 17:20 ET prod
    // bug (customer wrote Spanglish, Haiku decided "en", Sol replied
    // in English to a Spanish speaker).
    //
    // `reading` already comes pre-merged from extractCustomerFacts (it
    // runs mergeReading internally against existingProfile.reading), so
    // we just persist whatever it returned. `arrival_source` is preserved
    // across merges because freshReading.arrival_source is never emitted
    // by Haiku — only the webhook's turn-1 path seeds it.
    await upsertCustomerProfile(phone, {
      display_name: facts.display_name ?? null,
      summary: facts.summary ?? null,
      facts: facts.facts ?? [],
      reading: facts.reading ?? null,
    });
  }

  for (const s of suggestions) {
    await createKBSuggestion({
      question: s.question,
      answer: s.answer,
      category: s.category,
      conversation_id: conversationId,
      rationale: s.rationale,
    });
  }

  if (leadScore) {
    await upsertLeadScore(conversationId, leadScore);
    console.log(
      `[learning] Lead score for ${phone}: ${leadScore.quality} — ${leadScore.reason.slice(0, 80)}`
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

    case 'won': {
      // Operator confirms a conversation led to a sale. We stamp converted_at
      // and close the thread so it drops out of the active queue. The
      // customer never sees this — it's a private bookkeeping action.
      const conv = await getConversationByAnyPhone(args);
      if (!conv) {
        await sendWhatsAppMessage(operatorPhone, `❌ No encontré conversación con ${args}`);
        return;
      }
      if (conv.converted_at) {
        const whenIso = new Date(conv.converted_at).toLocaleDateString('es-CU');
        await sendWhatsAppMessage(
          operatorPhone,
          `ℹ️ ${args} ya estaba marcado como venta ganada (${whenIso}). No hice cambios.`
        );
        return;
      }
      await markConversationWon(conv.id);
      await sendWhatsAppMessage(
        operatorPhone,
        `✅ ${args} marcado como venta ganada. La conversación queda cerrada y aparece en el resumen semanal.`
      );
      break;
    }

    default:
      await sendWhatsAppMessage(operatorPhone, `❓ Comando desconocido: /${command}`);
  }
}

// ============================================================
// Product-image dispatch ([SEND_IMAGE:SKU] tag handler)
// ============================================================

// SKUs in the catalog can include dots and slashes (e.g. `L13SR48100BV3.0-1`),
// so accept `.` `/` in addition to `A-Z0-9_-`.
const IMAGE_TAG_REGEX = /\[SEND_IMAGE:\s*([A-Z0-9][A-Z0-9_\-./]*)\s*\]/gi;
const MAX_IMAGES_PER_REPLY = 3;
// Total image cap (across all SKUs) to avoid spamming the customer.
// 1 SKU → 2 images. 2 SKUs → 2 + 1 = 3. 3 SKUs → 1 each = 3.
const TOTAL_IMAGE_CAP_PER_REPLY = 4;
const IMAGES_PER_SKU_WHEN_SINGLE = 2;

/**
 * Strip `[SEND_IMAGE:SKU]` tags from Sol's reply and return the list of SKUs
 * (de-duplicated, capped at MAX_IMAGES_PER_REPLY, upper-cased).
 */
function extractImageTags(message: string): { text: string; skus: string[] } {
  const seen = new Set<string>();
  const skus: string[] = [];

  for (const match of message.matchAll(IMAGE_TAG_REGEX)) {
    const sku = match[1].toUpperCase();
    if (!seen.has(sku)) {
      seen.add(sku);
      skus.push(sku);
      if (skus.length >= MAX_IMAGES_PER_REPLY) break;
    }
  }

  const text = message.replace(IMAGE_TAG_REGEX, '').replace(/[ \t]+\n/g, '\n').trim();
  return { text, skus };
}

async function dispatchProductImages(phone: string, skus: string[]): Promise<void> {
  // Single SKU → up to 2 images (front + alt angle / use shot).
  // Multiple SKUs → 1 image each, capped at TOTAL_IMAGE_CAP_PER_REPLY.
  const perSku = skus.length === 1 ? IMAGES_PER_SKU_WHEN_SINGLE : 1;
  let sent = 0;

  for (const sku of skus) {
    if (sent >= TOTAL_IMAGE_CAP_PER_REPLY) break;
    const remaining = TOTAL_IMAGE_CAP_PER_REPLY - sent;
    const want = Math.min(perSku, remaining);

    try {
      const urls = await getProductImages(sku, want);
      if (urls.length === 0) {
        console.log(`[WEBHOOK] No image URLs for SKU ${sku} — skipping`);
        continue;
      }
      for (const url of urls) {
        await sendImage(phone, url);
        sent++;
      }
      console.log(`[WEBHOOK] Sent ${urls.length} image(s) for ${sku}`);
    } catch (err) {
      console.warn(`[WEBHOOK] Failed to send image(s) for ${sku}:`, err);
    }
  }
}
