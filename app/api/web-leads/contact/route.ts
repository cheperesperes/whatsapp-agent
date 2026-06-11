import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/web-leads/contact — the chat widget's email opt-in card.
//
// Stores a visitor's email + their EXPLICIT consent (checkbox, unchecked by
// default; the exact consent wording is persisted verbatim in consent_text —
// that's the legal record). Public + CORS'd to oiikon.com, same trust model
// as /api/chat: anonymous browser sessions, keyed by the widget session id.
//
// Anti-abuse: payload size caps, email format check, per-conversation
// idempotency (unique index on conversation_id + lower(email)), and the
// conversation must actually exist for the given web session.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKU_RE = /\b([EF]P?\d{3,4}[A-Z0-9-]{0,8})\b/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { sessionId?: string; email?: string; consent?: boolean; consentText?: string; language?: string };
  try {
    body = await request.json();
  } catch {
    return jsonWithCors(request, { ok: false, error: 'invalid json' }, { status: 400 });
  }

  const sessionId = (body.sessionId ?? '').trim().slice(0, 100);
  const email = (body.email ?? '').trim().toLowerCase().slice(0, 254);
  const consent = body.consent === true;
  const consentText = (body.consentText ?? '').trim().slice(0, 500);
  const language: 'es' | 'en' = body.language === 'en' ? 'en' : 'es';

  if (!sessionId) return jsonWithCors(request, { ok: false, error: 'sessionId required' }, { status: 400 });
  if (!EMAIL_RE.test(email)) return jsonWithCors(request, { ok: false, error: 'invalid email' }, { status: 400 });
  // No consent checkbox → no row. We only ever store consented contacts.
  if (!consent || !consentText) {
    return jsonWithCors(request, { ok: false, error: 'consent required' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // The conversation must exist for this web session (same lookup /api/chat
  // uses) — prevents blind inserts against arbitrary ids.
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('channel', 'web')
    .eq('web_session_id', sessionId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) return jsonWithCors(request, { ok: false, error: 'conversation not found' }, { status: 404 });

  // Best-effort product snapshot: the most recent assistant message with a
  // product link tells us what they were interested in.
  let productSku: string | null = null;
  try {
    const { data: msgs } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(10);
    const quote = (msgs ?? []).find(
      (m) => m.role === 'assistant' && /oiikon\.com\/product\//i.test(m.content)
    );
    productSku = quote?.content.match(SKU_RE)?.[1]?.toUpperCase() ?? null;
  } catch {
    /* snapshot is optional */
  }

  const { error } = await supabase.from('web_lead_contacts').upsert(
    {
      conversation_id: conv.id,
      email,
      language,
      consent_marketing: true,
      consent_text: consentText,
      product_sku: productSku,
    },
    { onConflict: 'conversation_id,email', ignoreDuplicates: true }
  );

  if (error && !/duplicate|conflict/i.test(error.message)) {
    console.error('[web-leads] insert failed:', error.message);
    return jsonWithCors(request, { ok: false, error: 'store failed' }, { status: 500 });
  }

  console.log(`[web-leads] consented contact stored conv=${conv.id} sku=${productSku ?? '-'} lang=${language}`);
  return jsonWithCors(request, { ok: true });
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  const allowed =
    origin === 'https://whatsapp-agent-ebon-nine.vercel.app' ||
    /^https:\/\/(www\.)?oiikon\.com$/.test(origin) ||
    /\.oiikon\.com$/.test(new URL(origin || 'https://x.invalid').hostname);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://oiikon.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function jsonWithCors(request: NextRequest, data: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, {
    status: init?.status ?? 200,
    headers: corsHeaders(request),
  });
}
