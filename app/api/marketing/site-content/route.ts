/**
 * /api/marketing/site-content
 *
 * Generates on-site engagement content (admin dashboard → oiikon.com storefront)
 * and publishes operator-approved entries into the SHARED storefront tables the
 * site already renders. This is the integration layer between the admin app and
 * the client site: both read/write the same Supabase project.
 *
 * v1 covers the FAQ type:
 *   POST { action: 'generate', type: 'faq', count? }
 *     → builds polished, public-facing FAQ candidates from the REAL, already
 *       operator-APPROVED Q&As in kb_suggestions (the clean source — the raw
 *       ai_user_questions table is chat noise). Deduped against the live
 *       faq_articles. NOTHING is persisted; candidates are returned for review.
 *   POST { action: 'publish', type: 'faq', items: [{question, answer, category, tags?}] }
 *     → inserts the operator-approved items into faq_articles (live on the site).
 *
 * The review gate is the operator approving candidates in the dashboard before
 * publish — so nothing reaches the public site unreviewed, and no draft table /
 * storefront change is needed.
 *
 * Brand/compliance rules are enforced in the prompt (USA-only, never Cuba/intl,
 * no invented specs/prices/dates, no fake testimonials, no hurricane fear, AI
 * honesty) — the same §3.x conduct the marketing generator uses.
 */
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from '@/lib/supabase';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 60;

const FAQ_CATEGORIES = ['envio', 'producto', 'tecnico', 'garantia', 'pago', 'general'] as const;

interface FaqCandidate {
  question: string;
  answer: string;
  category: string;
  tags?: string[];
}

async function requireUser(req: NextRequest): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    // Only allow unauthenticated calls outside production (local dev).
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }
  const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return Boolean(user);
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body?.action;
  const type = body?.type ?? 'faq';
  if (type !== 'faq') {
    return NextResponse.json({ error: `Unsupported content type: ${type}` }, { status: 400 });
  }

  const sb = createServiceClient();

  // ── PUBLISH ────────────────────────────────────────────────────────────────
  if (action === 'publish') {
    const items: FaqCandidate[] = Array.isArray(body?.items) ? body.items : [];
    const clean = items
      .filter((i) => i && typeof i.question === 'string' && typeof i.answer === 'string')
      .map((i) => ({
        question: String(i.question).trim().slice(0, 500),
        answer: String(i.answer).trim().slice(0, 4000),
        category: FAQ_CATEGORIES.includes((i.category || '').toLowerCase() as any)
          ? (i.category || '').toLowerCase()
          : 'general',
        tags: Array.isArray(i.tags) ? i.tags.slice(0, 8).map((t) => String(t)) : null,
      }))
      .filter((i) => i.question.length > 0 && i.answer.length > 0);

    if (clean.length === 0) {
      return NextResponse.json({ error: 'No valid FAQ items to publish' }, { status: 400 });
    }

    const { data, error } = await sb.from('faq_articles').insert(clean).select('id');
    if (error) {
      return NextResponse.json({ error: `Publish failed: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, publishedCount: data?.length ?? clean.length });
  }

  // ── GENERATE ─────────────────────────────────────────────────────────────────
  if (action === 'generate') {
    const count = Math.min(Math.max(Number(body?.count) || 8, 1), 15);

    // Clean source = operator-APPROVED kb_suggestions (real, vetted Q&As).
    const { data: approved } = await sb
      .from('kb_suggestions')
      .select('question, answer, category')
      .eq('status', 'approved')
      .limit(80);

    // Existing live FAQ — so we don't regenerate what's already published.
    const { data: existing } = await sb.from('faq_articles').select('question').limit(200);

    const source = (approved ?? [])
      .filter((s: any) => s?.question && s?.answer)
      .map((s: any) => `P: ${String(s.question).trim()}\nR: ${String(s.answer).trim()}`)
      .join('\n\n');

    if (!source) {
      return NextResponse.json(
        { error: 'No approved kb_suggestions found to source FAQ from.' },
        { status: 422 },
      );
    }

    const existingList = (existing ?? [])
      .map((e: any) => `• ${String(e.question).trim()}`)
      .join('\n');

    const prompt = `Eres editor de contenido de Oiikon (oiikon.com), tienda ESTADOUNIDENSE de estaciones solares portátiles y baterías LiFePO4. Estás creando entradas de PREGUNTAS FRECUENTES (FAQ) para la página pública del sitio.

FUENTE — preguntas y respuestas REALES ya aprobadas por el operador (de conversaciones con clientes). Úsalas como base; púlelas para una página pública:
"""
${source.slice(0, 12000)}
"""

FAQ QUE YA EXISTEN EN EL SITIO — NO las repitas ni generes variantes casi idénticas:
${existingList || '(ninguna)'}

REGLAS OBLIGATORIAS (si una regla choca con la fuente, GANA LA REGLA):
• Servicio solo dentro de EE.UU. (48 estados continentales). PROHIBIDO mencionar Cuba u otro país, envío internacional, o "enviar a la familia". Si la fuente menciona Cuba u otro país, REESCRIBE en contexto 100% EE.UU. o DESCARTA esa entrada.
• Neutralidad política total. Sin temas de gobiernos, embargos ni sanciones.
• Solo datos verificables. PROHIBIDO inventar especificaciones (Wh, Ah, horas, watts), precios, fechas de entrega, garantías o certificaciones. Si no estás seguro de un dato numérico, responde de forma cualitativa ("varias horas", "consulta la ficha del producto en oiikon.com").
• Sin urgencia falsa, sin testimonios/reseñas inventadas, sin superlativos no probados ("el #1", "garantizado", "el más barato"), sin consejo eléctrico/médico/legal.
• Sin alarmismo de huracanes/apagones; menciona el contexto con respeto y brevedad, enfocado en la SOLUCIÓN.
• Respuestas claras y útiles de 2 a 4 oraciones, en español neutro, tono cálido y profesional. Puedes invitar a escribir por WhatsApp o ver oiikon.com cuando aporte, pero la respuesta debe ser informativa por sí sola (no solo "escríbenos").

Genera ${count} entradas de FAQ NUEVAS, distintas entre sí y distintas a las existentes. Asigna a cada una UNA categoría de esta lista exacta: ${FAQ_CATEGORIES.join(', ')}.

Devuelve SOLO JSON válido, sin explicaciones, con esta forma:
{"faqs":[{"question":"...","answer":"...","category":"envio|producto|tecnico|garantia|pago|general","tags":["..."]}]}`;

    const anthropic = new Anthropic();
    let text = '';
    try {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    } catch (e: any) {
      return NextResponse.json({ error: `Generation failed: ${e?.message ?? String(e)}` }, { status: 502 });
    }

    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
    if (!match) {
      return NextResponse.json({ error: 'Model did not return valid JSON', raw: text.slice(0, 300) }, { status: 502 });
    }
    let parsed: { faqs?: FaqCandidate[] };
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      return NextResponse.json({ error: 'Could not parse model JSON', raw: text.slice(0, 300) }, { status: 502 });
    }

    const existingSet = new Set((existing ?? []).map((e: any) => String(e.question).trim().toLowerCase()));
    const candidates = (parsed.faqs ?? [])
      .filter((f) => f && f.question && f.answer)
      .map((f) => ({
        question: String(f.question).trim(),
        answer: String(f.answer).trim(),
        category: FAQ_CATEGORIES.includes((f.category || '').toLowerCase() as any)
          ? (f.category || '').toLowerCase()
          : 'general',
        tags: Array.isArray(f.tags) ? f.tags.slice(0, 8).map((t) => String(t)) : [],
      }))
      // Drop anything that slipped past the rules (Cuba/intl) or duplicates.
      .filter((f) => !/\bcuba\b|internacional|fuera de (ee\.?uu\.?|estados unidos)/i.test(`${f.question} ${f.answer}`))
      .filter((f) => !existingSet.has(f.question.toLowerCase()));

    return NextResponse.json({ ok: true, candidates, sourceCount: (approved ?? []).length });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
