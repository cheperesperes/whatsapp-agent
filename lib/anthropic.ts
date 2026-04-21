import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  Message,
  CustomerProfile,
  CustomerProfileFact,
  CustomerProfileReading,
} from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;

// Background extractors run inside `waitUntil` and SHARE the lambda's
// maxDuration with the main reply path. Each Haiku call must time out fast
// so a hung extractor can't kill the lambda before Sol's reply is sent.
const EXTRACT_TIMEOUT_MS = 5_000;

// Cache the agent prompt (read once at module load)
let _agentPromptCache: string | null = null;

function getAgentPrompt(): string {
  if (_agentPromptCache) return _agentPromptCache;

  try {
    const promptPath = join(process.cwd(), 'AGENT_PROMPT.md');
    _agentPromptCache = readFileSync(promptPath, 'utf-8');
    return _agentPromptCache;
  } catch {
    // Fallback minimal prompt if file can't be read
    return 'Eres Sol, el asistente virtual de Oiikon. Ayuda a los clientes con información sobre productos de energía solar en español.';
  }
}

export interface SolResponse {
  message: string;
  handoffReason: string | null;
  /**
   * Funnel metric tags Sol emitted (e.g. `discovery_complete`,
   * `recommendation_sent`, `close_attempt`, `objection_raised: precio`).
   * Stripped from the customer-facing message; surface them to analytics.
   */
  metrics: string[];
}

/**
 * Call Claude to generate Sol's response.
 * Returns the customer-facing message, any detected handoff reason, and
 * funnel metric tags. ALL internal tags (`[HANDOFF: ...]`, `[METRIC: ...]`,
 * `[OPTOUT: ...]`) are stripped from `message` so they never leak to
 * WhatsApp — they're metadata for the system, not text for the customer.
 */
export async function generateSolResponse(
  conversationHistory: Message[],
  newUserMessage: string,
  productCatalog: string,
  knowledgeBase = '',
  customerProfilePrompt = '',
  intentHint = '',
  competitorComparisons = '',
  languageLock = '',
  firstContactDirective = '',
  dynamicDirectives = ''
): Promise<SolResponse> {
  const basePrompt = getAgentPrompt();

  // The language lock and first-contact directive land LAST, after FECHA,
  // so they're the final instructions the model reads before generating.
  // Soft signals earlier in the prompt ("Idioma del cliente: es") were
  // being ignored in production — placing the hard lock at the tail fixes
  // that. The first-contact directive (only present on turn 1) is added
  // AFTER languageLock because it's the most recent-state instruction:
  // it tells Sol "this is turn 1 and here is exactly how to open". Without
  // it, Sol was treating FB-ad openers as real questions and dumping the
  // full catalog before the customer said anything concrete.
  //
  // `dynamicDirectives` lands at the very tail — these are situational
  // rules computed per-turn (soft-close mandate when customer is ready to
  // buy, pivot-before-backing-off when they just said "no me interesa").
  // Placing them last ensures they override earlier, more general guidance.
  const systemPrompt = `${basePrompt}

${productCatalog}
${knowledgeBase}
${customerProfilePrompt}
${competitorComparisons}
${intentHint ? `\n${intentHint}\n` : ''}
FECHA ACTUAL: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
${languageLock ? `\n${languageLock}\n` : ''}${firstContactDirective ? `\n${firstContactDirective}\n` : ''}${dynamicDirectives ? `\n${dynamicDirectives}\n` : ''}`;

  const messages: Anthropic.MessageParam[] = conversationHistory.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  messages.push({ role: 'user', content: newUserMessage });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    },
    {
      timeout: 22_000,
      headers: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    }
  );

  const rawText =
    response.content[0]?.type === 'text' ? response.content[0].text : '';

  const handoffMatch = rawText.match(/\[HANDOFF:\s*([^\]]+)\]/i);
  const handoffReason = handoffMatch ? handoffMatch[1].trim() : null;

  // Funnel metric tags: `[METRIC: discovery_complete]`,
  // `[METRIC: objection_raised: precio]`, etc.
  const metricMatches = rawText.matchAll(/\[METRIC:\s*([^\]]+)\]/gi);
  const metrics = Array.from(metricMatches, (m) => m[1].trim());

  // Strip ALL internal tags (HANDOFF, METRIC, OPTOUT) from the
  // customer-facing message. SEND_IMAGE is handled downstream by
  // extractImageTags in the webhook route.
  const customerMessage = rawText
    .replace(/\[HANDOFF:\s*[^\]]+\]/gi, '')
    .replace(/\[METRIC:\s*[^\]]+\]/gi, '')
    .replace(/\[OPTOUT:\s*[^\]]+\]/gi, '')
    .replace(/[ \t]+\n/g, '\n') // tidy trailing whitespace from stripped tags
    .replace(/\n{3,}/g, '\n\n') // collapse triple+ blank lines created by stripping
    .trim();

  return { message: customerMessage, handoffReason, metrics };
}

// ============================================================
// Automatic learning: customer profile + KB suggestions
// ============================================================

/**
 * Valid enum values for each reading dimension. Kept here so the
 * parser can coerce / reject unexpected strings from the model.
 */
const READING_INTENT_STAGES = new Set([
  'explorando',
  'evaluando',
  'listo_comprar',
  'post_venta',
]);
const READING_KNOWLEDGE_LEVELS = new Set(['novato', 'intermedio', 'experto']);
const READING_PRICE_SENSITIVITIES = new Set(['alta', 'media', 'baja']);
const READING_URGENCIES = new Set(['ya', 'semanas', 'meses', 'sin_prisa']);

/**
 * Coerce a string into a valid reading enum value, returning null for
 * unknown / empty / malformed input. Used per-field when parsing Haiku output.
 */
function coerceEnum<T extends string>(
  value: unknown,
  allowed: Set<string>
): T | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return allowed.has(v) ? (v as T) : null;
}

/**
 * Merge a new (partially-populated) read with the existing stored read,
 * enforcing the "null preserves existing" rule. A later turn emitting
 * `intent_stage: null` must NOT clobber a confident earlier read — that
 * would make the signal less useful as the conversation develops.
 * Only non-null fresh values overwrite. `objection_themes` unions and
 * caps at 6 to keep the prompt block bounded.
 */
function mergeReading(
  existing: CustomerProfileReading | null | undefined,
  fresh: Partial<CustomerProfileReading>,
  now: string
): CustomerProfileReading {
  const prev = existing ?? {};
  const merged: CustomerProfileReading = { ...prev };

  if (fresh.intent_stage != null) merged.intent_stage = fresh.intent_stage;
  if (fresh.knowledge_level != null) merged.knowledge_level = fresh.knowledge_level;
  if (fresh.price_sensitivity != null) merged.price_sensitivity = fresh.price_sensitivity;
  if (fresh.urgency != null) merged.urgency = fresh.urgency;
  if (fresh.arrival_source != null) merged.arrival_source = fresh.arrival_source;

  if (Array.isArray(fresh.objection_themes) && fresh.objection_themes.length > 0) {
    const prevThemes = prev.objection_themes ?? [];
    const combined = [...prevThemes, ...fresh.objection_themes]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    merged.objection_themes = Array.from(new Set(combined)).slice(-6);
  }

  merged.last_updated_at = now;
  return merged;
}

/**
 * Extract per-customer facts + structured read from a conversation thread.
 * Strict rule: only facts the customer literally stated.
 *
 * The read adds behavioral signals (intent_stage, knowledge_level,
 * price_sensitivity, urgency, objection_themes) used to adapt Sol's tone
 * and content on the next turn. Unlike `facts`, the read enums are closed
 * sets so the operator-facing dashboard can filter on them reliably.
 */
export async function extractCustomerFacts(
  history: Message[],
  existingProfile: CustomerProfile | null
): Promise<{
  display_name?: string | null;
  language?: string | null;
  summary?: string | null;
  facts?: CustomerProfileFact[];
  reading?: CustomerProfileReading | null;
} | null> {
  // Minimum of 2 messages (one user + one assistant) gives Haiku enough
  // to extract at least a `reading` signal. The old `< 3` gate meant the
  // FIRST full user→Sol→user→Sol exchange produced no read, so turn 2
  // replied with zero tone adaptation. Dropping to `< 2` closes that gap;
  // the Haiku extractor itself is precision-tuned, so a shallow read just
  // returns null/empty fields rather than hallucinating.
  if (history.length < 2) return null;

  const thread = history
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const existingFactsText = (existingProfile?.facts ?? []).map((f) => f.fact).join('\n- ');

  const prompt = `Analiza la siguiente conversación entre Sol (agente) y un CLIENTE. Extrae SOLO información que el cliente dijo explícitamente sobre sí mismo. No inventes. No infieras. Si no estás seguro, no lo incluyas.

Devuelve SOLO JSON válido con esta forma:
{
  "display_name": string | null,
  "language": "es" | "en" | null,
  "summary": string | null,
  "new_facts": string[],
  "reading": {
    "intent_stage": "explorando" | "evaluando" | "listo_comprar" | "post_venta" | null,
    "knowledge_level": "novato" | "intermedio" | "experto" | null,
    "price_sensitivity": "alta" | "media" | "baja" | null,
    "urgency": "ya" | "semanas" | "meses" | "sin_prisa" | null,
    "objection_themes": string[]
  }
}

Reglas de hechos:
- "display_name": solo si el cliente dijo claramente su nombre.
- "language": "es" si el cliente escribe en español, "en" si en inglés, null si ambiguo.
- "summary": máximo 200 caracteres, resumen neutral de quién es el cliente y qué busca (p.ej. "Cliente en Miami comprando para familia en Cuba; interesado en estación portátil para nevera y luces").
- "new_facts": hechos concretos que el cliente mencionó y que NO aparecen ya en la lista de hechos previos. Ejemplos: "Vive en Miami", "Compra para su madre en Santiago de Cuba", "Su familia tiene nevera vieja y ventilador", "Presupuesto cerca de $800". NO incluyas hechos genéricos o inferidos.

Reglas de lectura (SOLO emite un valor si hay SEÑAL EXPLÍCITA en la conversación; null si no):
- "intent_stage":
    • "listo_comprar" SOLO si preguntó por link, pago, envío, "cómo lo compro" o "dónde pago".
    • "evaluando" si compara productos, pide diferencias, o pregunta "¿cuál me recomienda?".
    • "explorando" por defecto cuando hay curiosidad sin comparación.
    • "post_venta" si ya compró y pregunta por uso o problemas.
- "knowledge_level":
    • "experto" SOLO si usa specs concretas (Wh, Ah, V, LFP, MPPT, kWh).
    • "novato" si hace preguntas básicas tipo "¿qué es eso?" o "¿cómo funciona?".
    • "intermedio" cuando conoce algo pero no usa specs.
- "price_sensitivity":
    • "alta" SOLO si pregunta por descuentos, financiamiento, o dice "es caro" / "muy costoso".
    • "baja" si pide "el mejor" o "más potente" sin mirar precio.
    • "media" por defecto.
- "urgency":
    • "ya" SOLO si menciona apagón activo o "lo necesito esta semana".
    • "semanas"/"meses" si menciona fecha concreta.
    • "sin_prisa" si dice "estoy explorando" o "para más adelante".
- "objection_themes": TEMAS que mencionó como obstáculo. Valores posibles (de este set): "envío", "confianza", "precio", "técnico", "pago", "compatibilidad". Máximo 6. Si no mencionó objeciones, devuelve [].

Si no hay nada nuevo que agregar, devuelve hechos en null y reading con todos los campos en null / [].

Hechos ya conocidos (no los repitas):
${existingFactsText || '(ninguno)'}

Conversación:
${thread}

Devuelve SOLO el JSON, sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: EXTRACT_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: EXTRACT_TIMEOUT_MS }
    );
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as {
      display_name: string | null;
      language: string | null;
      summary: string | null;
      new_facts: string[];
      reading?: {
        intent_stage?: unknown;
        knowledge_level?: unknown;
        price_sensitivity?: unknown;
        urgency?: unknown;
        objection_themes?: unknown;
      };
    };

    const now = new Date().toISOString();
    const existingFacts = existingProfile?.facts ?? [];
    const newFactObjects: CustomerProfileFact[] = (parsed.new_facts ?? [])
      .filter((f) => typeof f === 'string' && f.trim().length > 0)
      .map((f) => ({ fact: f.trim(), source_msg_id: null, verified_at: now }));

    const mergedFacts = [...existingFacts, ...newFactObjects].slice(-40);

    // Parse + validate the read. Any field that isn't a legal enum value
    // falls back to null so bad model output can't corrupt persisted state.
    const freshReading: Partial<CustomerProfileReading> = {
      intent_stage: coerceEnum<CustomerProfileReading['intent_stage'] & string>(
        parsed.reading?.intent_stage,
        READING_INTENT_STAGES
      ),
      knowledge_level: coerceEnum<CustomerProfileReading['knowledge_level'] & string>(
        parsed.reading?.knowledge_level,
        READING_KNOWLEDGE_LEVELS
      ),
      price_sensitivity: coerceEnum<CustomerProfileReading['price_sensitivity'] & string>(
        parsed.reading?.price_sensitivity,
        READING_PRICE_SENSITIVITIES
      ),
      urgency: coerceEnum<CustomerProfileReading['urgency'] & string>(
        parsed.reading?.urgency,
        READING_URGENCIES
      ),
      objection_themes: Array.isArray(parsed.reading?.objection_themes)
        ? (parsed.reading!.objection_themes as unknown[])
            .filter((t) => typeof t === 'string')
            .map((t) => (t as string).trim().toLowerCase())
            .filter((t) => t.length > 0)
        : [],
    };

    const mergedReading = mergeReading(existingProfile?.reading, freshReading, now);

    return {
      display_name: parsed.display_name ?? existingProfile?.display_name ?? null,
      language: parsed.language ?? existingProfile?.language ?? null,
      summary: parsed.summary ?? existingProfile?.summary ?? null,
      facts: mergedFacts,
      reading: mergedReading,
    };
  } catch (err) {
    console.warn('[extractCustomerFacts] failed:', err);
    return null;
  }
}

// Re-export the merge helper so the webhook can use it for the turn-1
// arrival_source seed (which doesn't go through Haiku).
export { mergeReading };

export interface KBSuggestionDraft {
  question: string;
  answer: string;
  category: string;
  rationale: string;
}

// ============================================================
// Self-evaluation: LLM judge scores conversations against Sol's rules
// ============================================================

export type ScorecardRuleId =
  | 'answered_the_ask'
  | 'recommended_with_link'
  | 'avoided_permission_asking'
  | 'avoided_irrelevant_limit'
  | 'no_hallucination'
  | 'concise_response';

export interface ScorecardRuleResult {
  passed: boolean;
  evidence: string;
}

export interface ScorecardResult {
  conversation_id: string;
  rules: Record<ScorecardRuleId, ScorecardRuleResult>;
  pass_count: number;
  rule_count: number;
  overall_summary: string;
  teachable_suggestion: KBSuggestionDraft | null;
}

export const SCORECARD_RULE_LABELS: Record<ScorecardRuleId, string> = {
  answered_the_ask: 'Responde lo que el cliente preguntó (Regla de Oro)',
  recommended_with_link: 'Incluye el link directo al recomendar producto',
  avoided_permission_asking: 'Evita "¿me permite…?" / "¿puedo preguntarle…?"',
  avoided_irrelevant_limit: 'No ofrece limitaciones irrelevantes sin que se las pregunten',
  no_hallucination: 'No inventa precios, specs, tiempos de entrega ni compatibilidades',
  concise_response: 'Respuestas 2–4 oraciones, proporcionales al pedido',
};

/**
 * Judge a conversation against Sol's rubric. Uses Haiku (cheap + fast).
 * Returns per-rule pass/fail + overall summary + optional teachable moment
 * that can be fed into the kb_suggestions queue for operator review.
 */
export async function judgeConversation(
  conversationId: string,
  history: Message[]
): Promise<ScorecardResult | null> {
  const userMsgCount = history.filter((m) => m.role === 'user').length;
  if (userMsgCount < 2) return null;

  const thread = history
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres un juez de calidad para un agente de ventas por WhatsApp llamado Sol (Oiikon, energía solar). Evalúa la siguiente conversación contra 6 reglas. Sé estricto pero justo: una sola violación clara en cualquier mensaje de Sol = "passed": false para esa regla.

Las 6 reglas:

1. **answered_the_ask** — Cuando el cliente hace una pregunta específica (precio, producto, cómo funciona, ¿sirve para X?), Sol responde esa pregunta ANTES de hacer preguntas propias. FAIL si Sol responde con otra pregunta sin dar info útil primero.

2. **recommended_with_link** — Cuando Sol menciona un producto específico con precio (ej. "E1500LFP $469"), incluye el link directo (https://oiikon.com/product/...) en la MISMA respuesta. FAIL si menciona modelo + precio sin link.

3. **avoided_permission_asking** — Sol NO dice "¿me permite preguntarle…?", "¿puedo sugerirle…?", "¿le interesaría que le explique…?". FAIL si cualquier mensaje de Sol usa esas frases o equivalentes.

4. **avoided_irrelevant_limit** — Sol NO ofrece limitaciones de un producto sin que el cliente las pregunte. Ejemplo FAIL: cliente preguntó "¿sirve para nevera y luces?" y Sol responde "sí, aunque no aguanta AC 220V…". Solo PASS si Sol menciona un límite cuando (a) el cliente preguntó por eso, (b) lo que el cliente necesita sobrepasa al equipo, o (c) el equipo queda al borde.

5. **no_hallucination** — Sol no inventa precios, capacidades en Wh, tiempos de entrega específicos, garantías ni compatibilidades. FAIL si dice algo como "le llega en 3 días" o inventa specs sin base clara en catálogo. Si no estás seguro, PASS.

6. **concise_response** — Respuestas de Sol son proporcionales al pedido. FAIL si Sol responde con 8+ líneas a una pregunta simple tipo "¿tienen fotos?", o si repite el mismo argumento de venta.

Devuelve SOLO JSON válido con esta forma:
{
  "rules": {
    "answered_the_ask": { "passed": true, "evidence": "cita corta del mensaje o razón" },
    "recommended_with_link": { "passed": true, "evidence": "..." },
    "avoided_permission_asking": { "passed": true, "evidence": "..." },
    "avoided_irrelevant_limit": { "passed": true, "evidence": "..." },
    "no_hallucination": { "passed": true, "evidence": "..." },
    "concise_response": { "passed": true, "evidence": "..." }
  },
  "overall_summary": "1-2 oraciones: qué hizo bien Sol y qué falló",
  "teachable_suggestion": null | {
    "question": "pregunta genérica que Sol respondió mal (en español, reutilizable)",
    "answer": "respuesta corta y correcta que Sol DEBERÍA haber dado (max 300 caracteres)",
    "category": "shipping" | "pricing" | "product" | "compatibility" | "warranty" | "payment" | "general",
    "rationale": "por qué esta entrada mejora a Sol (max 120 caracteres)"
  }
}

Solo propón teachable_suggestion si:
- La falla es generalizable a futuros clientes (no un caso único del cliente).
- Tienes una respuesta CORRECTA concreta (no una crítica general).
- Si no hay una falla enseñable clara, devuelve null.

Conversación:
${thread}

Devuelve SOLO el JSON, sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: EXTRACT_MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: EXTRACT_TIMEOUT_MS }
    );
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as {
      rules: Record<ScorecardRuleId, ScorecardRuleResult>;
      overall_summary?: string;
      teachable_suggestion?: KBSuggestionDraft | null;
    };

    const ruleIds: ScorecardRuleId[] = [
      'answered_the_ask',
      'recommended_with_link',
      'avoided_permission_asking',
      'avoided_irrelevant_limit',
      'no_hallucination',
      'concise_response',
    ];
    const rules: Record<ScorecardRuleId, ScorecardRuleResult> = {} as Record<
      ScorecardRuleId,
      ScorecardRuleResult
    >;
    let passCount = 0;
    for (const id of ruleIds) {
      const r = parsed.rules?.[id];
      const passed = !!r?.passed;
      rules[id] = {
        passed,
        evidence: typeof r?.evidence === 'string' ? r.evidence.slice(0, 240) : '',
      };
      if (passed) passCount++;
    }

    const teachable = parsed.teachable_suggestion;
    const teachableValid =
      teachable &&
      typeof teachable.question === 'string' &&
      typeof teachable.answer === 'string' &&
      teachable.question.trim().length > 0 &&
      teachable.answer.trim().length > 0
        ? {
            question: teachable.question.trim(),
            answer: teachable.answer.trim(),
            category: teachable.category?.trim() || 'general',
            rationale: teachable.rationale?.trim() || '',
          }
        : null;

    return {
      conversation_id: conversationId,
      rules,
      pass_count: passCount,
      rule_count: ruleIds.length,
      overall_summary: parsed.overall_summary?.slice(0, 400) ?? '',
      teachable_suggestion: teachableValid,
    };
  } catch (err) {
    console.warn(`[judgeConversation] failed for ${conversationId}:`, err);
    return null;
  }
}

// ============================================================
// Lead-quality scorer (Haiku 4.5) — triages conversations
// for the operator dashboard so Eduardo can prioritize follow-up.
// ============================================================

export type LeadQuality = 'hot' | 'warm' | 'cold' | 'dead';

export interface LeadScore {
  quality: LeadQuality;
  reason: string;
  recommended_action: string;
}

export const LEAD_QUALITY_LABELS: Record<LeadQuality, string> = {
  hot: 'Listo para comprar',
  warm: 'Interesado, indeciso',
  cold: 'Curioso, baja señal',
  dead: 'Perdido / fuera de tema',
};

/**
 * Classify a conversation's sales-readiness. Pure helper — exported for testing.
 * Returns null only on unparseable input.
 */
export function parseLeadScoreResponse(rawText: string): LeadScore | null {
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');

  let parsed: Partial<LeadScore>;
  try {
    parsed = JSON.parse(cleaned) as Partial<LeadScore>;
  } catch {
    return null;
  }

  const quality: LeadQuality =
    parsed.quality === 'hot' || parsed.quality === 'warm' || parsed.quality === 'cold' || parsed.quality === 'dead'
      ? parsed.quality
      : 'cold';

  return {
    quality,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    recommended_action:
      typeof parsed.recommended_action === 'string'
        ? parsed.recommended_action.slice(0, 200)
        : '',
  };
}

/**
 * Score a conversation as hot / warm / cold / dead.
 * Cheap (Haiku), runs in background after each customer turn.
 * Returns null on failure — caller skips the upsert.
 */
export async function scoreLeadQuality(history: Message[]): Promise<LeadScore | null> {
  const userMsgCount = history.filter((m) => m.role === 'user').length;
  if (userMsgCount < 1) return null;

  const thread = history
    .slice(-16)
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres un evaluador de calidad de leads para Sol, un agente de ventas de WhatsApp (Oiikon, energía solar para Cuba/USA). Lee la conversación y clasifica al cliente.

Conversación reciente:
${thread}

Devuelve SOLO este JSON:
{
  "quality": "hot" | "warm" | "cold" | "dead",
  "reason": "1 oración: por qué este lead está en esta categoría",
  "recommended_action": "1 oración: qué debería hacer Eduardo (operador) ahora"
}

Definiciones:
- "hot" — cliente expresó intención clara de compra ("lo quiero", "cómo pago", "envíenme el link", "lo llevo"), pidió detalles finales (forma de pago, tiempo de entrega, dirección), o aceptó un precio. Acción típica: confirmar venta / enviar link de pago.
- "warm" — cliente está enganchado, hizo preguntas sustantivas (precio, specs, compatibilidad) o enumeró equipos, pero NO ha cerrado. Tal vez se quedó callado tras un precio o comparó modelos. Acción típica: follow-up con pregunta o oferta concreta.
- "cold" — cliente solo saludó, hizo una pregunta vaga, o exploró sin compromiso. Poca señal de compra. Acción típica: dejar a Sol seguir nutriendo o esperar.
- "dead" — cliente claramente perdido: pidió hablar con humano y no respondió, dijo "no me interesa", se opt-out, o el hilo es spam/off-topic. Acción típica: archivar, no perseguir.

Reglas:
- Si Sol envió una recomendación con precio + link y el cliente NO respondió en su último mensaje, baja un nivel (warm → cold, hot → warm) — el silencio es señal débil.
- Si el cliente pidió hablar con humano: dead si han pasado varias horas sin respuesta de su lado, warm si el operador aún puede responder.
- Si la conversación es muy corta (1 mensaje del cliente) y no hay señal clara: cold.
- Sé conservador con "hot" — solo si hay intención inequívoca.

Devuelve SOLO el JSON. Sin markdown. Sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: EXTRACT_MODEL,
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: EXTRACT_TIMEOUT_MS }
    );

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    return parseLeadScoreResponse(text);
  } catch (err) {
    console.warn('[scoreLeadQuality] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Analyze a conversation and propose new KB entries — questions that
 * came up where the operator or Sol's answer could be reused across customers.
 */
export async function extractKBSuggestions(history: Message[]): Promise<KBSuggestionDraft[]> {
  if (history.length < 4) return [];

  const thread = history
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres un analista de calidad para un agente de ventas llamado Sol. Revisa esta conversación y propone entradas de base de conocimiento que servirán para FUTUROS clientes distintos.

Reglas estrictas:
- Solo propón preguntas que son genéricas y reutilizables (no nombres personales, no direcciones, no datos específicos del cliente).
- La respuesta debe ser clara, correcta y útil — basada en lo que Sol respondió Y que efectivamente resolvió la duda, O en lo que el cliente aclaró y Sol podría haber respondido mejor.
- Si Sol dijo algo inventado o incorrecto, NO lo propongas.
- Si no hay ninguna entrada digna, devuelve array vacío.
- Máximo 3 propuestas por conversación.

Devuelve SOLO JSON válido con esta forma:
{
  "suggestions": [
    {
      "question": "pregunta en español, genérica, bien formulada",
      "answer": "respuesta concisa y correcta (max 300 caracteres)",
      "category": "shipping" | "pricing" | "product" | "compatibility" | "warranty" | "payment" | "general",
      "rationale": "por qué esta entrada es útil (max 120 caracteres)"
    }
  ]
}

Conversación:
${thread}

Devuelve SOLO el JSON, sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: EXTRACT_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: EXTRACT_TIMEOUT_MS }
    );
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as { suggestions?: KBSuggestionDraft[] };
    const out = (parsed.suggestions ?? [])
      .filter((s) => s && typeof s.question === 'string' && typeof s.answer === 'string')
      .slice(0, 3);
    return out;
  } catch (err) {
    console.warn('[extractKBSuggestions] failed:', err);
    return [];
  }
}

// ============================================================
// Dynamic per-turn directives
// ============================================================

/**
 * Regex catching Spanish rejection signals we want to bounce off with a
 * lateral offer before Sol backs off. "muy caro" variants, "no me interesa",
 * "no tengo presupuesto", etc. Intentionally simple — precision > recall;
 * false positives would push Sol to keep selling when the customer actually
 * wants out. The list is deliberately short and in lowercase; the caller
 * lowercases the user text before matching.
 */
const REJECTION_PATTERNS: RegExp[] = [
  /\bno me interesa\b/,
  /\bno estoy interesad[oa]\b/,
  /\bmuy caro\b/,
  /\bmuy costoso\b/,
  /\bdemasiado caro\b/,
  /\bfuera de mi presupuesto\b/,
  /\bno tengo (ese )?presupuesto\b/,
  /\bno puedo pagar(?:l[oa])?\b/, // pagar / pagarlo / pagarla — all common
  /\bno me alcanza\b/,
  /\bmejor despu[eé]s\b/,
  /\bmejor m[aá]s adelante\b/,
  /\bya no quiero\b/,
];

/**
 * Detect whether the latest user message carries a rejection signal Sol
 * should pivot off of (offer a cheaper SKU, ask about budget, suggest
 * financing) rather than closing the conversation with a flat "entiendo".
 * Exported for unit testing.
 */
export function hasRejectionSignal(userText: string): boolean {
  const lowered = (userText ?? '').toLowerCase();
  return REJECTION_PATTERNS.some((re) => re.test(lowered));
}

/**
 * Build the per-turn "dynamic directives" block injected at the tail of
 * Sol's system prompt. These are computed every turn from:
 *
 *  • `userTurnCount` — how many user messages this conversation has seen
 *    (including the current one)
 *  • `intentStage` — the latest reading.intent_stage, if we have one
 *  • `lastUserText` — the message we're about to reply to (for rejection
 *    detection)
 *
 * The block is intentionally short so it doesn't dilute the base prompt.
 * Each rule is one sentence starting with a verb, matching the tone of the
 * rest of the prompt. Empty string return means "no dynamic rule applies
 * this turn" — the caller then skips the section entirely.
 *
 * Two rules currently:
 *   1. SOFT-CLOSE MANDATE: if intent_stage=listo_comprar AND user turn
 *      count ≥ 3, the reply must end with a concrete next step (direct
 *      product link, operator phone, or "¿te mando el pago?"). Catches the
 *      "Sol answered every question but never asked for the sale" pattern.
 *   2. POST-REJECTION PIVOT: if the current user message contains a
 *      rejection signal, the reply must offer one lateral option (cheaper
 *      SKU, financing hint, or a budget question) BEFORE acknowledging and
 *      backing off. No forcing — one pivot attempt, then respect the no.
 */
export function buildDynamicDirectives(args: {
  userTurnCount: number;
  intentStage?: CustomerProfileReading['intent_stage'];
  lastUserText: string;
}): string {
  const rules: string[] = [];

  if (args.intentStage === 'listo_comprar' && args.userTurnCount >= 3) {
    rules.push(
      '• CIERRE SUAVE OBLIGATORIO: el cliente ya está listo para comprar y llevan varios turnos. ' +
        'Termina tu mensaje con UN paso concreto: enlace directo al producto acordado, número del operador, ' +
        'o una pregunta de cierre ("¿te mando el link de pago ahora?"). NO re-vendas. NO dejes el turno ' +
        'abierto sin CTA.'
    );
  }

  if (hasRejectionSignal(args.lastUserText)) {
    rules.push(
      '• PIVOTE ANTES DE RETIRARTE: el cliente acaba de rechazar ("muy caro" / "no me interesa" / similar). ' +
        'Antes de cerrar amablemente, ofrece UNA alternativa lateral: un SKU más económico del catálogo, ' +
        'una pregunta corta sobre presupuesto ("¿qué rango manejas?"), o mencionar financiamiento si aplica. ' +
        'UNA sola propuesta, no insistas. Si vuelve a decir que no, respétalo y cierra con elegancia.'
    );
  }

  if (rules.length === 0) return '';

  return [
    '=== DIRECTIVAS DINÁMICAS DE ESTE TURNO (obligatorias — NO repitas estas etiquetas al cliente) ===',
    ...rules,
  ].join('\n');
}
