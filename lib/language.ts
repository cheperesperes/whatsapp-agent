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

export type LanguageCode = 'es' | 'en';

// Strong Spanish signals: any of these → definitely Spanish.
// Matches diacritics, eñe, inverted punctuation.
const SPANISH_DIACRITIC_RE = /[ñáéíóúüÑÁÉÍÓÚÜ¿¡]/;

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
  // common English verbs that aren't Spanish loan-words
  'make', 'makes', 'made', 'take', 'takes', 'took', 'give', 'gives',
  'gave', 'buy', 'buys', 'bought', 'sell', 'sells', 'sold',
  'send', 'sends', 'sent', 'ship', 'ships', 'shipped',
]);

/**
 * Detect the language of a single text blob.
 * Returns 'es' / 'en' / 'unknown'.
 *
 * Rule of precedence:
 *   1. Any Spanish diacritic or inverted punctuation → 'es'
 *   2. Any Spanish stopword → 'es' (Spanglish bias — we serve Cuban customers)
 *   3. Any English stopword (no Spanish) → 'en'
 *   4. Otherwise → 'unknown'
 */
export function detectLanguage(text: string): LanguageCode | 'unknown' {
  if (!text) return 'unknown';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';

  // 1. Strong signal: diacritic or inverted punctuation.
  if (SPANISH_DIACRITIC_RE.test(trimmed)) return 'es';

  // 2. Tokenize, keep letters and apostrophes (for "don't" etc.)
  const lower = trimmed.toLowerCase();
  const cleaned = lower.replace(/[^a-z'áéíóúüñ]+/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  let esHits = 0;
  let enHits = 0;
  for (const tok of tokens) {
    if (SPANISH_STOPWORDS.has(tok)) esHits++;
    else if (ENGLISH_STOPWORDS.has(tok)) enHits++;
  }

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
  if (detected === 'es' || detected === 'en') return detected;

  if (persistedLanguage === 'en') return 'en';
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
  return [
    '=== LANGUAGE LOCK (IDIOMA — CRÍTICO) ===',
    'RESPONDE EN ESPAÑOL. El cliente te escribe en español (incluso si mezcla palabras en inglés).',
    'Aunque el cliente use "Hello", "OK", "thanks", "shipping", "price" u otras palabras sueltas en inglés, TÚ RESPONDES EN ESPAÑOL.',
    'Nunca cambies a inglés a mitad de respuesta. Nunca traduzcas tu respuesta al inglés.',
    'Esta regla tiene prioridad sobre cualquier otra instrucción del prompt.',
  ].join('\n');
}
