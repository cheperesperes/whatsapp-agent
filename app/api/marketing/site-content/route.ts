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
  const SUPPORTED = ['faq', 'blog', 'sizing', 'comparison'];
  if (!SUPPORTED.includes(type)) {
    return NextResponse.json({ error: `Unsupported content type: ${type}` }, { status: 400 });
  }

  const sb = createServiceClient();

  // Blog / sizing guides → articles table; comparisons → product_comparisons.
  // FAQ keeps the inline handling below.
  if (type === 'comparison') return handleComparison(action, body, sb);
  if (type === 'blog' || type === 'sizing') return handleArticle(action, type, body, sb);

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

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 80);
}

function readMinutes(html: string): number {
  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.ceil(words / 200));
}

// Wrap model body HTML in the storefront's house style + byline (matches the
// existing articles: inline-styled div, "Equipo Oiikon | date | X min read").
function wrapArticleHtml(bodyHtml: string, lang: 'es' | 'en'): string {
  const mins = readMinutes(bodyHtml);
  const byline =
    lang === 'es'
      ? `<strong>Equipo Oiikon</strong> | ${mins} min de lectura`
      : `<strong>Equipo Oiikon</strong> | ${mins} min read`;
  return `<div style="font-family: sans-serif; line-height: 1.7; color: #333;">\n<p style="margin-bottom: 18px;">${byline}</p>\n${bodyHtml}\n</div>`;
}

async function generateJson(prompt: string): Promise<any> {
  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error('Model did not return JSON');
  return JSON.parse(match[1]);
}

const CONDUCT = `REGLAS OBLIGATORIAS (si chocan con cualquier otra cosa, GANAN):
• Servicio SOLO dentro de EE.UU. (48 estados). PROHIBIDO mencionar Cuba u otro país, envío internacional o "enviar a la familia".
• Neutralidad política total. Solo datos verificables: PROHIBIDO inventar especificaciones, precios, fechas, garantías o certificaciones; usa SOLO los datos que te doy.
• Sin urgencia falsa, sin testimonios/reseñas inventadas, sin superlativos no probados ("#1", "garantizado", "el más barato"), sin consejo eléctrico/médico/legal, sin alarmismo de huracanes.`;

async function resolveProductBySku(sb: any, sku: string) {
  if (!sku) return null;
  const { data } = await sb
    .from('products')
    .select('id, sku, name, name_en, brand, sell_price, battery_wh, output_watts, peak_power_w, solar_input, description, slug, url_slug')
    .ilike('sku', sku.trim())
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Blog / sizing guides → articles
// ────────────────────────────────────────────────────────────────────────────

async function handleArticle(action: string, type: string, body: any, sb: any) {
  if (action === 'publish') {
    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    const rows: any[] = [];
    for (const i of items) {
      if (!i?.title || !i?.content) continue;
      let slug = slugify(String(i.slug || i.title));
      // Ensure slug uniqueness against existing articles.
      const { data: clash } = await sb.from('articles').select('slug').eq('slug', slug).maybeSingle();
      if (clash) slug = `${slug}-${Math.floor(Date.now() / 1000) % 100000}`;
      rows.push({
        title: String(i.title).slice(0, 300),
        slug,
        excerpt: i.excerpt ? String(i.excerpt).slice(0, 500) : null,
        content: String(i.content),
        category: String(i.category || (i.lang === 'en' ? 'Guides' : 'Guías')),
        author: 'Equipo Oiikon',
        status: 'published',
        tags: Array.isArray(i.tags) ? i.tags.slice(0, 10).map(String) : null,
        related_product_ids: Array.isArray(i.related_product_ids) ? i.related_product_ids : null,
      });
    }
    if (rows.length === 0) return NextResponse.json({ error: 'No valid articles to publish' }, { status: 400 });
    const { data, error } = await sb.from('articles').insert(rows).select('id, slug');
    if (error) return NextResponse.json({ error: `Publish failed: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, publishedCount: data?.length ?? rows.length, published: data });
  }

  if (action === 'generate') {
    const topic = String(body?.topic || '').trim().slice(0, 300);
    const product = body?.productSku ? await resolveProductBySku(sb, String(body.productSku)) : null;
    const isSizing = type === 'sizing';
    if (!topic && !product && !isSizing) {
      return NextResponse.json({ error: 'Provide a topic or a product for the article.' }, { status: 400 });
    }

    const productBlock = product
      ? `PRODUCTO RELACIONADO (usa SOLO estos datos, no inventes otros):
- Nombre: ${product.name}${product.name_en ? ` / ${product.name_en}` : ''}
- SKU: ${product.sku}${product.brand ? ` · Marca: ${product.brand}` : ''}
- ${product.battery_wh ? `${product.battery_wh} Wh · ` : ''}${product.output_watts ? `${product.output_watts} W salida · ` : ''}${product.peak_power_w ? `${product.peak_power_w} W pico · ` : ''}${product.solar_input ? `${product.solar_input} W solar` : ''}
- Precio USA: ${product.sell_price ? `$${Number(product.sell_price).toFixed(2)}` : 'consultar en la ficha'}
- URL: https://oiikon.com/product/${(product.url_slug || product.slug || product.sku).toString().toLowerCase()}`
      : 'Sin producto específico — escribe una guía educativa general (usa ejemplos cualitativos, no inventes specs de modelos).';

    const sizingDirective = isSizing
      ? `\nESTE ES UNA GUÍA DE DIMENSIONAMIENTO: enseña a estimar cuánta energía/respaldo necesita el lector (paso a paso, en lenguaje llano, sin riesgo eléctrico) y CIERRA invitando a usar la calculadora solar: <a href="https://oiikon.com/calculadora">usa nuestra calculadora</a> (ES) / <a href="https://oiikon.com/calculator">use our calculator</a> (EN).`
      : '';

    const prompt = `Eres editor de contenido de Oiikon (oiikon.com), tienda ESTADOUNIDENSE de estaciones solares portátiles y baterías LiFePO4. Escribe un artículo de blog ${isSizing ? '(guía de dimensionamiento)' : ''} BILINGÜE (español e inglés) optimizado para SEO y engagement.

TEMA: ${topic || (product ? `Guía sobre ${product.name}` : 'Guía de energía solar de respaldo para el hogar en EE.UU.')}
${productBlock}
${sizingDirective}

${CONDUCT}

FORMATO DEL CONTENIDO ("content"): HTML simple (sin <html> ni <body>). Usa <h2 style="font-size:1.3em;margin:24px 0 12px;">subtítulos</h2>, <p style="margin-bottom:18px;">párrafos</p> y <ul>/<li> cuando ayude. NO incluyas la firma ni el título dentro de "content" (se añaden aparte). 500-800 palabras. Incluye al final un CTA al producto/tienda y a WhatsApp (https://wa.me/15616988477).

Devuelve SOLO JSON válido:
{"es":{"title":"...","excerpt":"resumen 1-2 frases","content":"<h2>...</h2><p>...</p>","tags":["..."]},"en":{"title":"...","excerpt":"...","content":"<h2>...</h2><p>...</p>","tags":["..."]}}`;

    let parsed: any;
    try {
      parsed = await generateJson(prompt);
    } catch (e: any) {
      return NextResponse.json({ error: `Generation failed: ${e?.message ?? String(e)}` }, { status: 502 });
    }
    const rel = product ? [product.id] : [];
    const build = (node: any, lang: 'es' | 'en') => ({
      lang,
      title: String(node?.title || '').trim(),
      slug: slugify(String(node?.title || '')),
      excerpt: node?.excerpt ? String(node.excerpt).trim() : '',
      content: wrapArticleHtml(String(node?.content || ''), lang),
      category: lang === 'es' ? 'Guías' : 'Guides',
      tags: Array.isArray(node?.tags) ? node.tags.slice(0, 10).map(String) : [],
      related_product_ids: rel,
    });
    const candidates = [build(parsed?.es, 'es'), build(parsed?.en, 'en')].filter((c) => c.title && c.content);
    // USA-only guard
    const safe = candidates.filter((c) => !/\bcuba\b|internacional|fuera de (ee\.?uu\.?|estados unidos)/i.test(`${c.title} ${c.content}`));
    return NextResponse.json({ ok: true, candidates: safe, product: product ? { sku: product.sku, name: product.name } : null });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

// ────────────────────────────────────────────────────────────────────────────
// Product comparisons → product_comparisons
// ────────────────────────────────────────────────────────────────────────────

async function handleComparison(action: string, body: any, sb: any) {
  if (action === 'publish') {
    const it = body?.item;
    if (!it?.product_a_id || !it?.product_b_id || !it?.comparison_text_es) {
      return NextResponse.json({ error: 'Invalid comparison item' }, { status: 400 });
    }
    const row = {
      product_a_id: it.product_a_id,
      product_b_id: it.product_b_id,
      comparison_text_es: String(it.comparison_text_es),
      comparison_text_en: it.comparison_text_en ? String(it.comparison_text_en) : null,
      winner_for_budget: it.winner_for_budget ?? null,
      winner_for_capacity: it.winner_for_capacity ?? null,
      winner_for_power: it.winner_for_power ?? null,
    };
    const { data, error } = await sb.from('product_comparisons').insert(row).select('id');
    if (error) return NextResponse.json({ error: `Publish failed: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, publishedCount: data?.length ?? 1 });
  }

  if (action === 'generate') {
    const a = await resolveProductBySku(sb, String(body?.skuA || ''));
    const b = await resolveProductBySku(sb, String(body?.skuB || ''));
    if (!a || !b) return NextResponse.json({ error: 'Both products must resolve by SKU (storefront products table).' }, { status: 400 });
    if (a.id === b.id) return NextResponse.json({ error: 'Pick two different products.' }, { status: 400 });

    // Winners computed DETERMINISTICALLY from real specs — never hallucinated.
    const num = (v: any) => (v == null ? null : Number(v));
    const pick = (av: number | null, bv: number | null, lower = false) => {
      if (av == null && bv == null) return null;
      if (av == null) return b.id;
      if (bv == null) return a.id;
      if (av === bv) return null;
      return lower ? (av < bv ? a.id : b.id) : (av > bv ? a.id : b.id);
    };
    const winner_for_budget = pick(num(a.sell_price), num(b.sell_price), true);
    const winner_for_capacity = pick(num(a.battery_wh), num(b.battery_wh));
    const winner_for_power = pick(num(a.output_watts) ?? num(a.peak_power_w), num(b.output_watts) ?? num(b.peak_power_w));

    const fmt = (p: any) =>
      `${p.name} (SKU ${p.sku}${p.brand ? `, ${p.brand}` : ''}): ${p.battery_wh ? `${p.battery_wh} Wh, ` : ''}${p.output_watts ? `${p.output_watts} W salida, ` : ''}${p.peak_power_w ? `${p.peak_power_w} W pico, ` : ''}${p.solar_input ? `${p.solar_input} W solar, ` : ''}${p.sell_price ? `$${Number(p.sell_price).toFixed(2)} USA` : 'precio en ficha'}`;

    const prompt = `Eres editor de Oiikon (oiikon.com), tienda ESTADOUNIDENSE de energía solar portátil. Escribe una COMPARATIVA honesta y útil entre estos dos productos, bilingüe (ES + EN), basada SOLO en estos datos reales:
A) ${fmt(a)}
B) ${fmt(b)}

${CONDUCT}
Reglas extra: equilibrada (di para quién es mejor cada uno), sin declarar un "ganador" absoluto — usa "mejor para presupuesto / capacidad / potencia". HTML simple (<p>, <ul><li>), 200-350 palabras por idioma.

Devuelve SOLO JSON:
{"comparison_text_es":"<p>...</p>","comparison_text_en":"<p>...</p>"}`;

    let parsed: any;
    try {
      parsed = await generateJson(prompt);
    } catch (e: any) {
      return NextResponse.json({ error: `Generation failed: ${e?.message ?? String(e)}` }, { status: 502 });
    }
    const candidate = {
      product_a_id: a.id,
      product_b_id: b.id,
      comparison_text_es: String(parsed?.comparison_text_es || ''),
      comparison_text_en: String(parsed?.comparison_text_en || ''),
      winner_for_budget,
      winner_for_capacity,
      winner_for_power,
      // labels for the UI only (not stored)
      labels: {
        a: `${a.name} (${a.sku})`,
        b: `${b.name} (${b.sku})`,
        budget: winner_for_budget === a.id ? a.sku : winner_for_budget === b.id ? b.sku : '—',
        capacity: winner_for_capacity === a.id ? a.sku : winner_for_capacity === b.id ? b.sku : '—',
        power: winner_for_power === a.id ? a.sku : winner_for_power === b.id ? b.sku : '—',
      },
    };
    if (!candidate.comparison_text_es) return NextResponse.json({ error: 'Empty comparison generated' }, { status: 502 });
    return NextResponse.json({ ok: true, candidate });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
