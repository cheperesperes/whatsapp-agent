/**
 * Facebook-ad landing detector + first-contact directives.
 *
 * Background: most Oiikon customers arrive via Facebook ads whose CTA opens
 * WhatsApp pre-populated with a template like "¿Qué productos ofrecen?" or
 * "Hello! Can I get more info on this?". The operator sees the SAME text
 * from dozens of different customers — it's a ping from the ad click, not
 * a real question.
 *
 * The production problem: Sol was treating these openers as literal questions
 * and dumping the catalog on turn 1. That overwhelms a curious ad-clicker
 * and loses the moment before they've even told us whether they're buying
 * for USA or for family in Cuba. Catalog-dumping is the opposite of what a
 * trained salesperson does.
 *
 * This module:
 *   • detects canonical ad openers (case / accent / punctuation tolerant,
 *     exact-match after normalization so real questions don't get routed
 *     into ad handling by accident);
 *   • builds a system-prompt directive that tells Sol "you're on turn 1,
 *     this is an ad click, ask ONE qualifying question, do NOT dump the
 *     catalog";
 *   • builds a softer directive for organic first contacts (when the
 *     customer's first message is a real question, not a template).
 *
 * Discipline: detection is STRICT (full normalized-string equality) so a
 * false positive — treating a real question as an ad opener — cannot
 * happen. False negatives are safe: they fall through to the gentler
 * organic-first-contact directive.
 */

// ── Detection ──────────────────────────────────────────────────────────────

export interface AdOpenerMatch {
  /** Stable tag for analytics ("fb_info_en", "fb_products_es", etc.). */
  variant: string;
  /** Language the opener was written in. Informs directive phrasing. */
  language: 'es' | 'en';
}

/**
 * Canonical ad-opener forms after normalization.
 *
 * Seeded from what the operator has actually observed at scale:
 *   20× "¿Qué productos ofrecen?"
 *   12× "Hello! Can I get more info on this?"
 *   N×  "¡Hola! Quiero más información"
 *
 * Plus close variants (same intent, slight wording) and pure greetings —
 * because a turn-1 "hola" is operationally identical to an ad ping: the
 * customer hasn't told us anything yet and needs the same segmenting
 * question.
 *
 * Keep this list short and distinctive — "info" alone stays in because
 * on turn 1 (the only place we check) it's unambiguously an ad-style
 * opener; after turn 1 it would never be evaluated.
 */
const CANONICAL_OPENERS: ReadonlyArray<{
  normalized: string;
  variant: string;
  language: 'es' | 'en';
}> = [
  // ── ES · "what products do you have" ────────────────────────
  { normalized: 'que productos ofrecen', variant: 'fb_products_es', language: 'es' },
  { normalized: 'que productos tienen', variant: 'fb_products_es', language: 'es' },
  { normalized: 'que ofrecen', variant: 'fb_products_es', language: 'es' },
  { normalized: 'cuales son sus productos', variant: 'fb_products_es', language: 'es' },
  { normalized: 'catalogo', variant: 'fb_products_es', language: 'es' },
  { normalized: 'me pueden enviar el catalogo', variant: 'fb_products_es', language: 'es' },
  // ── ES · "I want more info" ─────────────────────────────────
  { normalized: 'hola quiero mas informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'quiero mas informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'quisiera mas informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'mas informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'quiero informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'necesito informacion', variant: 'fb_info_es', language: 'es' },
  { normalized: 'quiero mas info', variant: 'fb_info_es', language: 'es' },
  { normalized: 'mas info', variant: 'fb_info_es', language: 'es' },
  { normalized: 'info', variant: 'fb_info_es', language: 'es' },
  { normalized: 'info por favor', variant: 'fb_info_es', language: 'es' },
  // ── ES · pure greetings (turn-1-only, treated as ad ping) ───
  { normalized: 'hola', variant: 'fb_greet_es', language: 'es' },
  { normalized: 'buenas', variant: 'fb_greet_es', language: 'es' },
  { normalized: 'buenos dias', variant: 'fb_greet_es', language: 'es' },
  { normalized: 'buenas tardes', variant: 'fb_greet_es', language: 'es' },
  { normalized: 'buenas noches', variant: 'fb_greet_es', language: 'es' },
  // ── EN · "I want more info" ─────────────────────────────────
  {
    normalized: 'hello can i get more info on this',
    variant: 'fb_info_en',
    language: 'en',
  },
  {
    normalized: 'can i get more info on this',
    variant: 'fb_info_en',
    language: 'en',
  },
  {
    normalized: 'can i have more information',
    variant: 'fb_info_en',
    language: 'en',
  },
  { normalized: 'more info', variant: 'fb_info_en', language: 'en' },
  { normalized: 'more information', variant: 'fb_info_en', language: 'en' },
  { normalized: 'i want more info', variant: 'fb_info_en', language: 'en' },
  {
    normalized: 'i would like more information',
    variant: 'fb_info_en',
    language: 'en',
  },
  // ── EN · pure greetings ─────────────────────────────────────
  { normalized: 'hi', variant: 'fb_greet_en', language: 'en' },
  { normalized: 'hello', variant: 'fb_greet_en', language: 'en' },
  { normalized: 'hey', variant: 'fb_greet_en', language: 'en' },
  { normalized: 'good morning', variant: 'fb_greet_en', language: 'en' },
  { normalized: 'good afternoon', variant: 'fb_greet_en', language: 'en' },
  { normalized: 'good evening', variant: 'fb_greet_en', language: 'en' },
];

/**
 * Normalize a first-message string for canonical opener comparison.
 *   • lowercase
 *   • strip diacritics (ñ→n, á→a, …)
 *   • drop punctuation ¿¡ ? ! . , ; : ( ) " '
 *   • collapse internal whitespace
 *   • trim
 * Exported for tests and debugging.
 */
export function normalizeForOpenerMatch(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    // drop common punctuation + typographic quotes. Keep letters, digits,
    // and whitespace.
    .replace(/[¿¡?!.,;:()"'\u2018\u2019\u201C\u201D]/g, '')
    // drop trailing emoji / pictographs — a template "¡Hola! 😊" shouldn't
    // miss the "hola" match because of the smiley.
    .replace(/[\p{Extended_Pictographic}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Length guard — if the message is longer than this, it's almost certainly
 * not a canned ad opener. Protects against a real first-turn question that
 * happens to contain an opener substring.
 */
const OPENER_MAX_CHARS = 80;

/**
 * Match the customer's (trimmed, unmodified) message against the canonical
 * ad-opener list. Returns null if no exact-normalized match.
 *
 * STRICT: exact equality after normalization. No fuzzy / Levenshtein / keyword
 * bag. The list is expected to grow over time as the operator surfaces new
 * templates from real logs; adding a variant is cheaper than a bug where Sol
 * skips answering a real question because we fuzzy-matched it to an opener.
 */
export function detectAdOpener(text: string): AdOpenerMatch | null {
  if (!text) return null;
  if (text.length > OPENER_MAX_CHARS) return null;
  const normalized = normalizeForOpenerMatch(text);
  if (!normalized) return null;
  for (const opener of CANONICAL_OPENERS) {
    if (normalized === opener.normalized) {
      return { variant: opener.variant, language: opener.language };
    }
  }
  return null;
}

// ── Prompt directives ──────────────────────────────────────────────────────

/**
 * Directive for turn 1 when we detected an ad opener. Injected at the tail
 * of the system prompt (like `languageLock`) so it's the last instruction
 * the model reads before generating the reply.
 *
 * The directive is deliberately prescriptive:
 *   1. Tells Sol *why* this is different ("they just clicked an ad").
 *   2. Dictates the SHAPE of the reply (greet + ONE qualifier).
 *   3. Forbids the failure mode ("do NOT list products").
 *   4. Provides a concrete example question so she doesn't paraphrase into
 *      something vague.
 *
 * Written in the customer's detected language — even though the base prompt
 * is in Spanish, a language-matched directive here gives the model a clearer
 * signal about the tone and phrasing of the reply it should produce.
 */
export function formatAdArrivalDirective(match: AdOpenerMatch): string {
  if (match.language === 'en') {
    return [
      '=== TURN 1 · FACEBOOK AD ARRIVAL (LEAD WITH VALUE) ===',
      'This customer just clicked a Facebook ad and sent a template opener ("Hello! Can I get more info on this?", "More info"). They are HIGH-INTENT but VANISH if you only ask a question — real data shows a bare-question turn-1 loses ~60% of these. Give value FIRST, then ONE soft question.',
      '',
      'YOUR REPLY MUST (3–5 short lines):',
      '• One-line warm intro ("Hi, I\'m Sol from Oiikon 👋").',
      '• If you KNOW the product they clicked (AD CONTEXT / product_interest), LEAD with it: name it, price + free US shipping + ONE concrete benefit + the direct product link. Ex: "You\'re looking at the PECRON E3600LFP — 3,840Wh, runs a fridge + fans + lights through an outage, $1,049 with free US shipping 👉 <link>."',
      '• If you do NOT know the product, anchor on the best-seller: "Most folks here grab the PECRON E3600LFP — keeps a fridge, fans, lights & TV running during outages, $1,049, free US shipping."',
      '• THEN end with ONE light question that ADDS to the value ("Is this for your home, or more for an RV/off-grid?"). Never a question ALONE.',
      '',
      'YOUR REPLY MUST NOT:',
      '• Open with a bare qualifying question and nothing else (the #1 conversion killer).',
      '• Dump the full catalog or the 3-price ladder.',
      '• Hand off to a human on turn 1.',
    ].join('\n');
  }
  return [
    '=== TURNO 1 · LLEGÓ DESDE UN AD DE FACEBOOK (DA VALOR PRIMERO) ===',
    'Este cliente hizo clic en un anuncio de Facebook y mandó un saludo de plantilla ("Quiero más información", "Hola"). Es ALTA INTENCIÓN pero DESAPARECE si solo le haces una pregunta — los datos reales muestran que abrir con una pregunta sola pierde ~60% de estos clientes. Da VALOR primero, luego UNA pregunta suave.',
    '',
    'TU RESPUESTA DEBE (3–5 líneas cortas):',
    '• Presentación cálida de una línea ("Hola, soy Sol de Oiikon 👋").',
    '• Si SABES qué producto vio (bloque AD CONTEXT / product_interest), ARRANCA con él: nómbralo, precio + envío gratis EE.UU. + UN beneficio concreto + el link directo. Ej: "Está viendo el PECRON E3600LFP — 3,840Wh, mantiene nevera + ventiladores + luces en un apagón, $1,049 con envío gratis 👉 <link>."',
    '• Si NO sabes el producto, ancla en el más vendido: "La mayoría aquí elige el PECRON E3600LFP — mantiene nevera, ventiladores, luces y TV en un apagón, $1,049, envío gratis EE.UU."',
    '• LUEGO cierra con UNA pregunta ligera que SUME al valor ("¿Es para su casa, o más bien para un RV/off-grid?"). Nunca una pregunta SOLA.',
    '',
    'TU RESPUESTA NO DEBE:',
    '• Abrir con una pregunta de calificación sola y nada más (el killer #1 de conversión).',
    '• Volcar el catálogo completo ni el bloque de 3 precios.',
    '• Escalar a un humano en el turno 1.',
  ].join('\n');
}

/**
 * Softer directive for organic first contacts — customer's first message is
 * a real question or comment, not a template. Sol still needs to greet and
 * introduce herself on turn 1, but she should also ANSWER what they asked
 * rather than pivoting to a qualifier.
 */
export function formatFirstContactDirective(language: 'es' | 'en'): string {
  if (language === 'en') {
    return [
      '=== TURN 1 · NEW CUSTOMER ===',
      'This is this customer\'s FIRST message. Open with a brief one-line intro ("Hi, I\'m Sol from Oiikon 👋").',
      'NEVER reply with ONLY a question — data shows bare-question openers lose most new customers. Always give a piece of concrete VALUE first (a relevant product + price + free US shipping, or a direct answer to what they asked), THEN one light question.',
      'If they asked a concrete question (price, warranty, cheapest, etc.): answer it directly in 2–4 lines, include the price + free US shipping + the direct product link, and end with one soft next-step question. If vague/generic: anchor on the best-seller (PECRON E3600LFP, $1,049, runs fridge+fans+lights+TV in an outage, free US shipping) and ask one qualifier. No full catalog dumps on turn 1.',
    ].join('\n');
  }
  return [
    '=== TURNO 1 · CLIENTE NUEVO ===',
    'Este es el PRIMER mensaje del cliente. Abre con una presentación de una línea ("Hola, soy Sol de Oiikon 👋").',
    'NUNCA respondas SOLO con una pregunta — los datos muestran que abrir solo con pregunta pierde a la mayoría de clientes nuevos. Da SIEMPRE un valor concreto primero (un producto relevante + precio + envío gratis EE.UU., o la respuesta directa a lo que preguntó), LUEGO una pregunta suave.',
    'Si hizo una pregunta concreta (precio, garantía, el más barato, etc.): respóndela directo en 2–4 líneas, incluye precio + envío gratis EE.UU. + el link directo del producto, y cierra con una pregunta suave de siguiente paso. Si es vago/genérico: ancla en el más vendido (PECRON E3600LFP, $1,049, mantiene nevera+ventiladores+luces+TV en apagón, envío gratis EE.UU.) y haz una sola pregunta. Nada de volcar el catálogo en el primer turno.',
  ].join('\n');
}

/**
 * Convenience: given a turn-1 message + the language lock we already
 * detected, return the directive that should be injected into the system
 * prompt. Null means "not turn 1" (caller decided elsewhere) or the text
 * was empty — in both cases, no directive is added.
 */
export function buildFirstContactDirective(
  firstMessage: string,
  detectedLanguage: 'es' | 'en'
): { directive: string; adMatch: AdOpenerMatch | null } | null {
  if (!firstMessage?.trim()) return null;
  const adMatch = detectAdOpener(firstMessage);
  if (adMatch) {
    return { directive: formatAdArrivalDirective(adMatch), adMatch };
  }
  return {
    directive: formatFirstContactDirective(detectedLanguage),
    adMatch: null,
  };
}
