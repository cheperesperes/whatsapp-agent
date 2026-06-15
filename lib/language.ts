/**
 * Deterministic language detector + hard "language lock" prompt builder.
 *
 * Why this exists: Sol's system prompt already said "respond in the
 * customer's language" and the Haiku intent classifier already returned
 * `language: 'es' | 'en'`. Both were soft signals buried deep in the
 * prompt. Production on 2026-04-20 showed Sol replying in English to
 * "Hello! Que capacidad tiene esa Pecron E1000 LFP?" — a message that's
 * 80% Spanish with an English loan-opener. The soft signals lost.
 *
 * Fix: a zero-cost heuristic that detects Spanish confidently (any
 * diacritic, any Spanish function word wins → Spanish) and injects a
 * HARD directive at the END of the system prompt. Model sees it last,
 * closest to next-token prediction.
 *
 * Policy: Spanglish = Spanish. Oiikon's customer base is Cuban families,
 * so when in doubt, default to Spanish. The customer may use English
 * loan-words ("OK", "Hello", "thanks", "shipping") — they're still a
 * Spanish-speaking customer.
 */

export type LanguageCode = 'es' | 'en' | 'fr' | 'ht';

// Strong Spanish signals: any of these → definitely Spanish.
// Matches diacritics, eñe, inverted punctuation.
const SPANISH_DIACRITIC_RE = /[ñáéíóúüÑÁÉÍÓÚÜ¿¡]/;

// ── French + Haitian Creole (added 2026-06-10) ──────────────────────
// Real case: Jean Pierre (+509, Haiti) wrote "Le prix ?" four times and the
// detector classified it Spanish ("le"/"la" are Spanish stopwords too), so the
// hard lock forced Spanish replies the customer couldn't read. Policy per Ed:
// answer in the customer's NATIVE language. We detect fr/ht with
// zero-collision vocabularies and check them BEFORE Spanish (the collision
// direction is fr→es, never es→fr).
//
// French-only diacritics: grave/circumflex/cedilla. Deliberately EXCLUDES the
// acute accents (é í ó ú) shared with Spanish.
const FRENCH_DIACRITIC_RE = /[àèùâêîôûçœÀÈÙÂÊÎÔÛÇ]/;

// French words with no Spanish/English collision ("le", "la", "les" excluded
// on purpose — they're in the Spanish list).
const FRENCH_STOPWORDS = new Set([
  'bonjour', 'bonsoir', 'merci', 'oui',
  'je', "j'ai", 'vous', 'votre', 'vos', 'nous',
  'puis', 'peux', 'pouvez', 'voudrais', 'veux', 'aimerais',
  'combien', 'prix', 'coûte', 'coute', 'acheter', 'livraison', 'envoyer',
  "c'est", "s'il", "qu'est", 'est-ce', 'pourquoi', 'comment',
  'pour', 'une', 'avec', 'besoin', 'maison', 'aussi',
  'panneau', 'panneaux', 'solaire', 'solaires', 'batterie', 'batteries',
  'énergie', 'electricité', 'électricité', 'portative', 'portatif',
]);

// Haitian Creole — highly distinctive vocabulary, checked FIRST (some Creole
// words carry French-style diacritics like è, which would otherwise trip the
// French check).
const CREOLE_STOPWORDS = new Set([
  'bonjou', 'bonswa', 'mèsi', 'mesi', 'tanpri', 'souple',
  'mwen', 'nou', 'kijan', 'konbyen', 'kisa', 'poukisa',
  'eske', 'èske', 'genyen', 'vle', 'bezwen', 'kapab',
  'kay', 'pri', 'kouran', 'limyè', 'limye', 'avèk', 'avek',
  'voye', 'achte', 'peye', 'lajan',
]);

// Spanish function words and common Sol-domain vocabulary.
// Must NOT collide with English words — avoid "a", "no", "is", "si", "me"
// (which exists in both; "me" in English is pronoun, in Spanish is pronoun,
// but in context appears in both too often). Err on the side of fewer words
// with zero overlap.
const SPANISH_STOPWORDS = new Set([
  // articles / determiners
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'le', 'les',
  // conjunctions / prepositions
  'que', 'qué', 'porque', 'pero', 'aunque', 'pues', 'con', 'sin', 'para',
  'por', 'sobre', 'entre', 'desde', 'hasta', 'según', 'contra',
  'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde', 'quien', 'quién',
  'cuanto', 'cuánto', 'cuanta', 'cuánta', 'cuantos', 'cuántos',
  // common verbs
  'es', 'son', 'está', 'estan', 'están', 'estoy', 'estamos',
  'tengo', 'tiene', 'tienen', 'tener', 'tenía', 'tuve',
  'hay', 'haber', 'soy', 'somos', 'fui', 'fue',
  'puedo', 'puede', 'pueden', 'podría', 'podemos',
  'quiero', 'quiere', 'queremos', 'quería', 'quisiera',
  'necesito', 'necesita', 'necesitan', 'necesitamos',
  'hago', 'hace', 'hacen', 'voy', 'va', 'vamos', 'van',
  // common domain words
  'precio', 'cuesta', 'vale', 'valor', 'envío', 'envio', 'cuba',
  'aquí', 'allá', 'allí', 'acá', 'esto', 'eso', 'aquello',
  'esta', 'este', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'muy', 'más', 'mas', 'menos', 'mucho', 'mucha', 'muchos', 'muchas',
  'poco', 'poca', 'pocos', 'pocas', 'todo', 'toda', 'todos', 'todas',
  'nada', 'algo', 'alguien', 'nadie', 'siempre', 'nunca', 'jamás',
  'gracias', 'hola', 'buenos', 'buenas', 'días', 'tardes', 'noches',
  'señor', 'señora', 'señorita', 'amigo', 'amiga',
  // numbers
  'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'cien', 'ciento', 'mil',
  // adjectives
  'bueno', 'buena', 'mejor', 'peor', 'grande', 'pequeño', 'pequeña',
  'nuevo', 'nueva', 'viejo', 'vieja',
  // personal pronouns unique to Spanish
  'yo', 'tú', 'usted', 'ustedes', 'nosotros', 'ellos', 'ellas',
  // typical Cuban/LATAM colloquial
  'apagón', 'apagon', 'apagones', 'luz', 'corriente', 'planta',
  // question openers
  'tienen', 'tienes', 'puedo', 'podría', 'podrían',
]);

// English function words with NO Spanish collision. These are strong
// signals that the customer is writing English, not Spanish.
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'with', 'have', 'has', 'had', 'been', 'being',
  'this', 'that', 'these', 'those',
  'what', 'where', 'when', 'who', 'why', 'how',
  'would', 'could', 'should', 'will', 'can', 'may', 'might',
  'want', 'wants', 'need', 'needs', 'think', 'thinks',
  'know', 'knows', 'like', 'likes',
  'about', 'from', 'into', 'because', 'just', 'only', 'also',
  'your', 'yours', 'their', 'theirs', 'them', 'they', 'there',
  "i'm", "don't", "doesn't", "isn't", "aren't", "wasn't", "weren't",
  "it's", "that's", "you're", "we're", "they're",
  'please', 'thanks', 'thank',
  'hello', 'hey', 'yes', 'yeah', 'yep', 'nope',
  'price', 'shipping', 'much', 'cost', 'cheap', 'expensive',
  'power', 'battery', 'solar', 'watt', 'watts',
  // Short standalone openers we saw default-to-Spanish incorrectly when they
  // were the customer's first/only word. All zero-collision with Spanish.
  'house', 'home', 'info', 'more', 'fridge', 'fridges', 'lights', 'outage',
  'outages', 'backup', 'whole', 'camping', 'off-grid', 'offgrid', 'rv',
  // common English verbs that aren't Spanish loan-words
  'make', 'makes', 'made', 'take', 'takes', 'took', 'give', 'gives',
  'gave', 'buy', 'buys', 'bought', 'sell', 'sells', 'sold',
  'send', 'sends', 'sent', 'ship', 'ships', 'shipped',
]);

/**
 * Detect the language of a single text blob.
 * Returns 'es' / 'en' / 'fr' / 'ht' / 'unknown'.
 *
 * Rule of precedence:
 *   1. Any Creole word → 'ht' (most distinctive vocabulary; checked before
 *      French because Creole uses French-style diacritics like è)
 *   2. Any French word or French-only diacritic (à è ù ç …) → 'fr'
 *      (checked before Spanish — "le"/"la" collide toward Spanish)
 *   3. Any Spanish diacritic or inverted punctuation → 'es'
 *   4. Any Spanish stopword → 'es' (Spanglish bias — we serve Cuban customers)
 *   5. Any English stopword (no Spanish) → 'en'
 *   6. Otherwise → 'unknown'
 */
export function detectLanguage(text: string): LanguageCode | 'unknown' {
  if (!text) return 'unknown';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';

  // Tokenize, keep letters, apostrophes (for "don't" / "c'est") and hyphens
  // dropped. Diacritics preserved for the fr/ht vocabularies.
  const lower = trimmed.toLowerCase();
  const cleaned = lower.replace(/[^a-z'áéíóúüñàèùâêîôûçœè]+/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  let esHits = 0;
  let enHits = 0;
  let frHits = 0;
  let htHits = 0;
  for (const tok of tokens) {
    if (CREOLE_STOPWORDS.has(tok)) htHits++;
    else if (FRENCH_STOPWORDS.has(tok)) frHits++;
    else if (SPANISH_STOPWORDS.has(tok)) esHits++;
    else if (ENGLISH_STOPWORDS.has(tok)) enHits++;
  }

  // 1-2. Creole, then French — BEFORE the Spanish checks (see precedence note).
  if (htHits > 0) return 'ht';
  if (frHits > 0 || FRENCH_DIACRITIC_RE.test(trimmed)) return 'fr';

  // 3. Strong Spanish signal: diacritic or inverted punctuation.
  if (SPANISH_DIACRITIC_RE.test(trimmed)) return 'es';

  if (esHits > 0) return 'es';
  if (enHits > 0) return 'en';
  return 'unknown';
}

/**
 * Detect language from a conversation history.
 * Aggregates the last 5 user messages into a single blob so short
 * ambiguous messages ("ok", "E1500LFP") inherit context from prior turns.
 *
 * Fallback order when detection returns 'unknown':
 *   1. `persistedLanguage` from customer_profiles (if set)
 *   2. 'es' — Spanish is Oiikon's customer-base default
 */
export function detectLanguageFromHistory(
  recentUserMessages: string[],
  persistedLanguage?: string | null
): LanguageCode {
  const blob = recentUserMessages.slice(-5).join(' ');
  const detected = detectLanguage(blob);
  if (detected !== 'unknown') return detected;

  if (
    persistedLanguage === 'en' ||
    persistedLanguage === 'fr' ||
    persistedLanguage === 'ht'
  ) {
    return persistedLanguage;
  }
  return 'es';
}

/**
 * Build the hard language-lock block that's injected at the END of the
 * system prompt. "Hard" because it uses imperative, capitalizes the
 * language, and tells the model exactly what not to do.
 *
 * Placed last in the prompt for two reasons:
 *   1. Anthropic's model attention biases toward the end of the system prompt
 *   2. Recency — closer to the model's next-token generation
 */
export function formatLanguageLockForPrompt(lang: LanguageCode): string {
  if (lang === 'en') {
    return [
      '=== LANGUAGE LOCK ===',
      'RESPOND IN ENGLISH. The customer is writing to you in English.',
      'Even if you see a Spanish word or phrase in their message, respond in English.',
      'Never switch to Spanish mid-reply. Never translate your reply.',
    ].join('\n');
  }
  if (lang === 'fr') {
    return [
      '=== LANGUAGE LOCK (LANGUE — CRITIQUE) ===',
      "RÉPONDS EN FRANÇAIS. Le client t'écrit en français — toute ta réponse doit être en français, chaleureuse et naturelle.",
      'Le catalogue et les instructions sont en espagnol/anglais : traduis en français toute l\'information pertinente pour le client (prix, capacités, recommandations).',
      'Garde les noms de produits, les SKU, les prix en USD et les liens EXACTEMENT tels quels — ne traduis jamais un lien.',
      "Ne réponds JAMAIS en espagnol ni en anglais. Cette règle a priorité sur toute autre instruction du prompt.",
    ].join('\n');
  }
  if (lang === 'ht') {
    return [
      '=== LANGUAGE LOCK (LANG — KRITIK) ===',
      'REPONN AN KREYÒL AYISYEN. Kliyan an ap ekri w an kreyòl — tout repons ou dwe an kreyòl ayisyen, cho e natirèl.',
      'Katalòg la ak enstriksyon yo an panyòl/anglè: tradui an kreyòl tout enfòmasyon ki enpòtan pou kliyan an (pri, kapasite, rekòmandasyon).',
      'Kenbe non pwodwi yo, SKU yo, pri an USD ak lyen yo EGZAKTEMAN jan yo ye — pa janm tradui yon lyen.',
      'PA JANM reponn an panyòl oswa an anglè. Règ sa a gen priyorite sou tout lòt enstriksyon.',
    ].join('\n');
  }
  return [
    '=== LANGUAGE LOCK (IDIOMA — CRÍTICO) ===',
    'RESPONDE EN ESPAÑOL. El cliente te escribe en español (incluso si mezcla palabras en inglés).',
    'Aunque el cliente use "Hello", "OK", "thanks", "shipping", "price" u otras palabras sueltas en inglés, TÚ RESPONDES EN ESPAÑOL.',
    'Nunca cambies a inglés a mitad de respuesta. Nunca traduzcas tu respuesta al inglés.',
    'Esta regla tiene prioridad sobre cualquier otra instrucción del prompt.',
  ].join('\n');
}

// ── Other browser languages (beyond the heuristic's es/en/fr/ht) ────────────
// The keyword heuristic only knows es/en/fr/ht. When a visitor's MESSAGE gives
// no language signal but their browser/page is set to another specific language
// (Portuguese, Italian, German…), we reply in THAT language — the model writes
// all of them fluently. es/en/fr/ht are omitted on purpose: the message
// heuristic owns those, and a weak/ambiguous message shouldn't be overridden by
// the browser locale.
const OTHER_LANGUAGE_NAMES: Record<string, string> = {
  pt: 'Portuguese', it: 'Italian', de: 'German', nl: 'Dutch', ru: 'Russian',
  uk: 'Ukrainian', pl: 'Polish', ro: 'Romanian', tr: 'Turkish', ar: 'Arabic',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', vi: 'Vietnamese',
  tl: 'Tagalog', th: 'Thai', id: 'Indonesian', el: 'Greek', sv: 'Swedish',
};

/** Map a browser/page language tag (e.g. "pt-BR") to a language NAME we should
 *  reply in — only for languages the es/en/fr/ht heuristic doesn't own.
 *  Returns null for es/en/fr/ht (handled by the message heuristic) and unknowns. */
export function browserLanguageName(browserLang?: string | null): string | null {
  if (!browserLang) return null;
  const base = browserLang.toLowerCase().trim().split(/[-_]/)[0];
  return OTHER_LANGUAGE_NAMES[base] || null;
}

/** Generic hard language lock for ANY language (browser-detected languages the
 *  heuristic doesn't hand-code). The model is fluent in all of them. */
export function formatGenericLanguageLockForPrompt(languageName: string): string {
  const L = languageName;
  return [
    `=== LANGUAGE LOCK (${L.toUpperCase()} — CRITICAL) ===`,
    `RESPOND ENTIRELY IN ${L}. The customer is browsing in ${L} — your whole reply must be in ${L}, warm and natural.`,
    `Translate all catalog info (prices, capacities, recommendations) into ${L}.`,
    `Keep product names, SKUs, USD prices and links EXACTLY as-is — never translate a link.`,
    `Do NOT reply in Spanish or English unless the customer writes to you in it. This rule overrides any other prompt instruction.`,
  ].join('\n');
}

export interface ResolvedLanguage {
  /** Heuristic code for storage/validation (es/en/fr/ht). 'other' langs store as 'es'. */
  code: LanguageCode;
  /** Language-lock block to inject at the END of the system prompt. */
  lock: string;
  /** Set when replying in a browser-detected language outside es/en/fr/ht. */
  otherName?: string;
}

/**
 * Decide the reply language + lock from the message history, a persisted
 * preference, and (web only) the visitor's browser/page language.
 *
 * Precedence:
 *   1. A confident MESSAGE-language detection (es/en/fr/ht) always wins — it's
 *      the strongest signal and those vocabularies don't false-collide.
 *   2. If the message gives NO signal ('unknown') and the browser is set to a
 *      specific OTHER language (pt/it/de/…), reply in that language.
 *   3. Otherwise the persisted preference, else Spanish (Cuban-base default).
 */
export function resolveLanguage(
  recentUserMessages: string[],
  persistedLanguage?: string | null,
  browserLang?: string | null
): ResolvedLanguage {
  const blob = recentUserMessages.slice(-5).join(' ');
  const detected = detectLanguage(blob);
  if (detected !== 'unknown') {
    return { code: detected, lock: formatLanguageLockForPrompt(detected) };
  }
  const otherName = browserLanguageName(browserLang);
  if (otherName) {
    return { code: 'es', lock: formatGenericLanguageLockForPrompt(otherName), otherName };
  }
  const fallback: LanguageCode =
    persistedLanguage === 'en' || persistedLanguage === 'fr' || persistedLanguage === 'ht'
      ? persistedLanguage
      : 'es';
  return { code: fallback, lock: formatLanguageLockForPrompt(fallback) };
}
