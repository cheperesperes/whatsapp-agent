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
 * for their home, an RV, or a business. Catalog-dumping is the opposite of what a
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
 *   2. Dictates the SHAPE of the reply (helpful advisor: intro + purpose +
 *      the product's REAL per-SKU specs + expected runtime + a help-question).
 *   3. Forbids the failure mode (price or buy-link before they engage).
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
      '=== TURN 1 · FACEBOOK AD ARRIVAL (WIN THE SECOND MESSAGE BY HELPING) ===',
      'This customer just clicked a Facebook ad and sent a template opener ("More info", "Hi"). They are CURIOUS, not ready to buy. Your turn-1 job is to EARN A REPLY by starting a HELPFUL relationship — introduce yourself, teach them about the product they saw, and offer to help. NEVER open by pushing a payment. A price or buy-link on the first message reads as pressure and is the #1 reason these leads vanish.',
      '',
      'YOUR REPLY (a helpful advisor, warm, ~4–6 short lines):',
      '• Introduce yourself: "Hi, my name is Sol and I\'m here to help 😊".',
      '• Frame the PURPOSE of the product they saw — backup power for emergencies and outages (also small RVs, camping or work) — and the RESULT: keeps your fridge, fans, TV and lights running, no gas, no noise, ready to use.',
      '• Give the REAL specs of THAT product from your catalog: capacity (Wh), output (W) + peak (W), voltage (110V or 220V per the model), and that it recharges with solar panels. USE THE ACTUAL NUMBERS OF THE MODEL THEY SAW — never invent, and never say 220V if the unit is 110V only.',
      '• Give a sense of the expected DURATION: it depends on the load — give a realistic example ("a fridge + fans + lights can last almost 2 days").',
      '• Close by HELPING, not selling: "What do you need to keep running when the power goes out? With that I\'ll tell you exactly how many hours it lasts and whether this is the right fit — I\'m here for whatever you need 🙏".',
      '',
      'YOUR REPLY MUST NOT:',
      '• Quote a price or send a buy-link unprompted — hold BOTH until they engage. Relationship and help first, NOT payment.',
      '• Invent specs or give another model\'s numbers — only the real specs of the unit they saw. If you don\'t know which product they clicked, frame the general purpose (emergency backup) and ask what they want to power.',
      '• Dump the whole catalog or hand off to a human.',
      '',
      'IF they explicitly ask the price on turn 1: never give a bare number — anchor it (was → now, amount saved), add free US shipping, then turn it back into a help-question ("…but first let me make sure it\'s the right fit — what do you want to power?").',
    ].join('\n');
  }
  return [
    '=== TURNO 1 · LLEGÓ DESDE UN AD DE FACEBOOK (GANA EL SEGUNDO MENSAJE AYUDANDO) ===',
    'Este cliente hizo clic en un anuncio y mandó un saludo de plantilla ("Quiero más información", "Hola"). Está CURIOSO, no listo para comprar. Tu misión en el turno 1 es GANAR UNA RESPUESTA estableciendo una RELACIÓN de ayuda — preséntate, edúcalo sobre el producto que vio, y ofrécele ayuda. NUNCA empieces empujando un pago. Un precio o un link de compra en el primer mensaje se siente como presión y es la causa #1 de que estos clientes desaparezcan.',
    '',
    'TU RESPUESTA (una asesora que ayuda, cálida, ~4–6 líneas cortas):',
    '• Preséntate: "Hola, mi nombre es Sol y estoy aquí para ayudarle 😊".',
    '• Plantea el PROPÓSITO del producto que vio — respaldo de energía para emergencias y cortes de luz (también RV pequeños, camping o trabajo) — y el RESULTADO: mantiene su nevera, ventiladores, TV y luces andando, sin gasolina, sin ruido, listo para usar.',
    '• Dale los DATOS REALES de ESE producto, de tu catálogo: capacidad (Wh), salida (W) + pico (W), voltaje (110V o 220V según el modelo), y que se recarga con paneles solares. USA LOS NÚMEROS REALES DEL MODELO QUE VIO — nunca inventes, y nunca pongas 220V si el equipo es solo 110V.',
    '• Da una idea de la DURACIÓN esperada: depende de lo que conecte — pon un ejemplo realista ("una nevera + ventiladores + luces pueden durar casi 2 días").',
    '• Cierra AYUDANDO, no vendiendo: "¿Qué equipos necesita mantener andando cuando se va la luz? Con eso le digo las horas exactas y si es el ideal para usted — aquí estoy para lo que necesite 🙏".',
    '',
    'TU RESPUESTA NO DEBE:',
    '• Dar un precio ni un link de compra sin que lo pidan — guarda AMBOS hasta que el cliente se enganche. Primero la relación y la ayuda, NO el pago.',
    '• Inventar specs ni dar números de otro modelo — solo los datos reales del equipo que vio. Si no sabes qué producto vio, plantea el propósito general (respaldo en emergencias) y pregunta qué quiere alimentar.',
    '• Volcar el catálogo entero ni escalar a un humano.',
    '',
    'SI pide el precio explícitamente en el turno 1: nunca des un número solo — áncoralo (antes → ahora, cuánto ahorra), suma envío gratis EE.UU., y devuélvelo a una pregunta de ayuda ("…pero primero déjeme confirmarle que es el correcto para lo suyo — ¿qué quiere alimentar?").',
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
      'This is the customer\'s FIRST message. Open with a one-line intro ("Hi, I\'m Sol from Oiikon 👋").',
      'If they asked a concrete question (price, warranty, which model, etc.): answer it directly in 2–4 lines. For a price, never give a bare number — anchor it (was → now, amount saved) + free US shipping + 30-day returns, then a soft next-step question.',
      'If vague/generic: lead with the OUTCOME (what it solves and how it feels — "keep your fridge, lights and fans running through an outage, no gas or noise"), then ONE easy question. Do NOT quote a price or send a buy-link unprompted, and never open with a bare question. No catalog dumps.',
    ].join('\n');
  }
  return [
    '=== TURNO 1 · CLIENTE NUEVO ===',
    'Este es el PRIMER mensaje del cliente. Abre con una presentación de una línea ("Hola, soy Sol de Oiikon 👋").',
    'Si hizo una pregunta concreta (precio, garantía, qué modelo, etc.): respóndela directo en 2–4 líneas. Para un precio, nunca des un número solo — áncoralo (antes → ahora, cuánto ahorra) + envío gratis EE.UU. + 30 días de garantía, y cierra con una pregunta suave de siguiente paso.',
    'Si es vago/genérico: arranca con el RESULTADO (qué resuelve y cómo se siente — "mantenga su nevera, luces y ventiladores en un apagón, sin gasolina ni ruido"), luego UNA pregunta fácil. NO des precio ni link de compra sin que lo pidan, y nunca abras con una pregunta sola. Nada de volcar el catálogo.',
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
  // fr/ht fall back to the Spanish directive TEXT — the language lock at the
  // prompt tail forces the customer-facing reply into the customer's language.
  detectedLanguage: 'es' | 'en' | 'fr' | 'ht'
): { directive: string; adMatch: AdOpenerMatch | null } | null {
  if (!firstMessage?.trim()) return null;
  const adMatch = detectAdOpener(firstMessage);
  if (adMatch) {
    return { directive: formatAdArrivalDirective(adMatch), adMatch };
  }
  return {
    directive: formatFirstContactDirective(detectedLanguage === 'en' ? 'en' : 'es'),
    adMatch: null,
  };
}
