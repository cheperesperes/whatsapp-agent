// ============================================================
// Website chat agent — POST /api/chat
// ============================================================
// Browser widget hits this endpoint with { sessionId, message }.
// Reuses Sol's brain (generateSolResponse + catalog + KB + profile)
// and stores the conversation in Supabase tagged channel='web'.
//
// Why this exists: Meta's WhatsApp Cloud API silently drops outbound
// messages to Cuban WhatsApp accounts (sanctions filter). The website
// widget bypasses Meta entirely — Cuban visitors who reach oiikon.com
// can chat with Sol directly, no phone number required.

import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

export const dynamic = 'force-dynamic';

import {
  getOrCreateWebConversation,
  loadRecentMessages,
  storeMessage,
  loadAgentCatalog,
  formatProductCatalogForPrompt,
  loadKnowledgeBase,
  formatKnowledgeBaseForPrompt,
  loadCustomerProfile,
  upsertCustomerProfile,
  formatCustomerProfileForPrompt,
  createKBSuggestion,
  getProductImages,
  upsertLeadScore,
  countRecentUserMessagesFromPhone,
} from '@/lib/supabase';
import {
  generateSolResponse,
  extractCustomerFacts,
  extractKBSuggestions,
  scoreLeadQuality,
  buildDynamicDirectives,
} from '@/lib/anthropic';
import { classifyIntent, formatIntentHintForPrompt } from '@/lib/classifier';
import {
  loadCompetitorModels,
  formatCompetitorsForPrompt,
  loadCompetitorStats,
  formatCompetitorStatsForPrompt,
} from '@/lib/competitors';
import { extractAndPersist as extractCompetitorMention } from '@/lib/competitor-extractor';
import {
  detectLanguageFromHistory,
  formatLanguageLockForPrompt,
} from '@/lib/language';
import { buildFirstContactDirective } from '@/lib/ad-landing';
import type { CustomerProfile, Message } from '@/lib/types';

// Per-session abuse cap (rolling hour). Mirrors HOURLY_MESSAGE_CAP in webhook.
const HOURLY_MESSAGE_CAP = Number(process.env.HOURLY_MESSAGE_CAP ?? 40);

// `[SEND_IMAGE:SKU]` extraction — same regex as the webhook.
const IMAGE_TAG_REGEX = /\[SEND_IMAGE:\s*([A-Z0-9][A-Z0-9_\-./]*)\s*\]/gi;
const MAX_IMAGES_PER_REPLY = 3;

interface ChatRequest {
  sessionId: string;
  message: string;
  displayName?: string | null;
}

interface ChatImage {
  sku: string;
  url: string;
}

interface ChatResponse {
  reply: string;
  images: ChatImage[];
  handoff: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return jsonWithCors(request, { error: 'invalid_json' }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  const message = body.message?.trim();

  if (!sessionId || !/^[a-zA-Z0-9_-]{8,64}$/.test(sessionId)) {
    return jsonWithCors(request, { error: 'invalid_session_id' }, { status: 400 });
  }
  if (!message) {
    return jsonWithCors(request, { error: 'empty_message' }, { status: 400 });
  }
  if (message.length > 2000) {
    return jsonWithCors(request, { error: 'message_too_long' }, { status: 400 });
  }

  // Synthetic identifier for rate-limit lookups (the rate-limit query is
  // keyed on phone_number; web sessions store their identifier as
  // `web::sessionId` for that lookup only).
  const syntheticPhone = `web::${sessionId}`;

  const conversation = await getOrCreateWebConversation(sessionId, body.displayName ?? undefined);

  // Per-session rolling-hour cap to match the WhatsApp webhook's behavior.
  const recentCount = await countRecentUserMessagesFromPhone(syntheticPhone, 60);
  if (recentCount >= HOURLY_MESSAGE_CAP) {
    return jsonWithCors(request, {
      reply: 'Has alcanzado el límite de mensajes por hora. Un especialista te contactará pronto si es urgente.',
      images: [],
      handoff: 'rate_cap_exceeded',
    });
  }

  // Persist the user message synchronously so the conversation is durable
  // even if downstream AI fails.
  try {
    await storeMessage(conversation.id, 'user', message, false);
  } catch (err) {
    console.error('[chat] storeMessage user FAILED:', err);
    return jsonWithCors(request, { error: 'persist_failed' }, { status: 500 });
  }

  try {
    const [history, products, knowledgeEntries, customerProfile, competitors, competitorStats] = await Promise.all([
      loadRecentMessages(conversation.id, 20),
      loadAgentCatalog(),
      loadKnowledgeBase(),
      loadCustomerProfile(syntheticPhone),
      loadCompetitorModels(),
      loadCompetitorStats(),
    ]);

    // Fire-and-forget competitor extraction
    const recentUserMessages = history
      .filter((m) => m.role === 'user')
      .slice(-3, -1)
      .map((m) => m.content);
    waitUntil(extractCompetitorMention(
      message,
      products.map((p) => ({ sku: p.sku, name: p.name })),
      recentUserMessages,
    ));

    const historyWithoutLast = history.slice(0, -1);

    const catalog = formatProductCatalogForPrompt(products);
    const kbPrompt = formatKnowledgeBaseForPrompt(knowledgeEntries);
    const profilePrompt = formatCustomerProfileForPrompt(customerProfile);
    const competitorPrompt =
      formatCompetitorsForPrompt(competitors, products) +
      formatCompetitorStatsForPrompt(competitorStats);

    const intent = await classifyIntent(historyWithoutLast, message);
    const intentHint = formatIntentHintForPrompt(intent);

    const recentUserMsgs = [
      ...historyWithoutLast.filter((m) => m.role === 'user').slice(-4).map((m) => m.content),
      message,
    ];
    const detectedLang = detectLanguageFromHistory(recentUserMsgs, customerProfile?.language);
    const languageLock = formatLanguageLockForPrompt(detectedLang);

    if (customerProfile?.language !== detectedLang) {
      waitUntil(
        upsertCustomerProfile(syntheticPhone, { language: detectedLang }).catch((err) =>
          console.warn(`[chat] language persist failed for ${syntheticPhone}:`, err)
        )
      );
    }

    let firstContactDirective = '';
    if (historyWithoutLast.length === 0) {
      const built = buildFirstContactDirective(message, detectedLang);
      if (built) firstContactDirective = built.directive;
    }

    const userTurnCount = historyWithoutLast.filter((m) => m.role === 'user').length + 1;
    const dynamicDirectives = buildDynamicDirectives({
      userTurnCount,
      intentStage: customerProfile?.reading?.intent_stage ?? undefined,
      lastUserText: message,
    });

    const { message: aiMessage, handoffReason } = await generateSolResponse(
      historyWithoutLast,
      message,
      catalog,
      kbPrompt,
      profilePrompt,
      intentHint,
      competitorPrompt,
      languageLock,
      firstContactDirective,
      dynamicDirectives,
      'web', // channelHint
    );

    // Extract `[SEND_IMAGE:SKU]` tags into a structured image list the
    // frontend renders inline (instead of sending separate WhatsApp media).
    const { text: cleanText, skus } = extractImageTags(aiMessage);
    const images = await resolveImages(skus);

    await storeMessage(conversation.id, 'assistant', cleanText, !!handoffReason);

    waitUntil(
      runBackgroundLearning(conversation.id, syntheticPhone, [
        ...history,
        { id: '', conversation_id: conversation.id, role: 'assistant', content: cleanText, handoff_detected: !!handoffReason, created_at: new Date().toISOString() },
      ], customerProfile).catch((err) => console.warn('[chat][learning] failed:', err))
    );

    return jsonWithCors(request, {
      reply: cleanText,
      images,
      handoff: handoffReason,
    });
  } catch (err) {
    console.error('[chat] AI error:', err);
    const fallback = 'Lo siento, tuve un problema técnico. Por favor intenta de nuevo en un momento.';
    try {
      await storeMessage(conversation.id, 'assistant', fallback, false);
    } catch {
      /* ignore */
    }
    return jsonWithCors(request, { reply: fallback, images: [], handoff: null });
  }
}

// CORS preflight — the widget will be embedded on oiikon.com (different
// origin from whatsapp-agent-ebon-nine.vercel.app) and browsers will send
// an OPTIONS preflight before POST. Allow oiikon.com explicitly.
export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function jsonWithCors(
  request: NextRequest,
  data: unknown,
  init?: { status?: number }
): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, {
    status: init?.status ?? 200,
    headers: corsHeaders(request),
  });
}

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  const allowed = new Set([
    'https://oiikon.com',
    'https://www.oiikon.com',
    'https://whatsapp-agent-ebon-nine.vercel.app',
  ]);
  return {
    'Access-Control-Allow-Origin': allowed.has(origin) ? origin : 'https://oiikon.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

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

async function resolveImages(skus: string[]): Promise<ChatImage[]> {
  const out: ChatImage[] = [];
  for (const sku of skus) {
    try {
      const urls = await getProductImages(sku, 1);
      if (urls[0]) out.push({ sku, url: urls[0] });
    } catch (err) {
      console.warn(`[chat] resolveImages failed for ${sku}:`, err);
    }
  }
  return out;
}

async function runBackgroundLearning(
  conversationId: string,
  identifier: string,
  history: Message[],
  existingProfile: CustomerProfile | null
) {
  if (history.length < 2) return;

  const [facts, suggestions, leadScore] = await Promise.all([
    extractCustomerFacts(history, existingProfile),
    extractKBSuggestions(history),
    scoreLeadQuality(history),
  ]);

  if (facts) {
    await upsertCustomerProfile(identifier, {
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
  }
}
