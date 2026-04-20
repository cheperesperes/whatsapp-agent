import Anthropic from '@anthropic-ai/sdk';
import type { Message } from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
// Tight inline budget — classifier blocks Sol's reply, so degrade to "no hint"
// fast rather than burn the webhook's maxDuration on a slow Haiku call.
const CLASSIFIER_TIMEOUT_MS = 2_000;
const CLASSIFIER_MAX_TOKENS = 350;

export type IntentStage =
  | 'greeting'
  | 'discovery_open'
  | 'equipment_listed'
  | 'price_asked'
  | 'ready_to_buy'
  | 'objection'
  | 'logistics'
  | 'vague_followup'
  | 'off_topic';

export interface IntentClassification {
  stage: IntentStage;
  prior_assistant_recommended: boolean;
  equipment_mentioned: string[];
  destination_hint: 'cuba' | 'usa' | null;
  language: 'es' | 'en';
  needs_handoff: boolean;
  notes: string;
}

const STAGE_HINTS: Record<IntentStage, string> = {
  greeting: 'Saludo o apertura. Responde cálido y haz UNA pregunta de descubrimiento.',
  discovery_open:
    'Cliente abrió tema de necesidad pero sin equipos concretos. Una pregunta de descubrimiento (típica) y luego avanza.',
  equipment_listed:
    'Cliente ya enumeró equipos. APLICA "comprométete y expande": calcula con asunción 8-10h, recomienda con precio + link, NO hagas más preguntas de descubrimiento.',
  price_asked:
    'Cliente pidió precio. Aplica formato 3-tramos o el modelo concreto si ya hay contexto. Incluye link.',
  ready_to_buy:
    'Cliente muestra intención de compra ("me interesa", "lo quiero", "cómo pago"). Envía link directo + instrucciones de cierre. NO re-cualifiques.',
  objection:
    'Cliente tiene una duda o resistencia (precio, confianza, envío). Responde la objeción específica con datos concretos. No cambies de tema.',
  logistics:
    'Cliente pregunta sobre envío, pago, tiempos, garantía. Responde con la info concreta. Anticipa la próxima pregunta.',
  vague_followup:
    'Respuesta vaga del cliente ("algún que otro", "depende"). COMPROMÉTETE con lo que SÍ dijo, ofrece expansión inline. NO preguntes más.',
  off_topic:
    'Mensaje fuera del flujo de venta (broma, social, prueba). Responde breve y reconduce con calidez.',
};

/**
 * Detect whether Sol's previous assistant turn included a product recommendation
 * (price + product link). Pure helper — exported for testing.
 */
export function lastAssistantHadRecommendation(history: Message[]): boolean {
  const recent = history.slice(-8);
  const lastAssistant = [...recent].reverse().find((m) => m.role === 'assistant');
  return (
    !!lastAssistant && /https?:\/\/oiikon\.com\/product\//i.test(lastAssistant.content)
  );
}

/**
 * Parse the raw Haiku response into a typed IntentClassification.
 * Strips ```json fences, applies defaults, clamps fields. Pure — exported for testing.
 * Returns null only if JSON is unparseable.
 */
export function parseClassifierResponse(
  rawText: string,
  fallbackPriorRec: boolean
): IntentClassification | null {
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');

  let parsed: Partial<IntentClassification>;
  try {
    parsed = JSON.parse(cleaned) as Partial<IntentClassification>;
  } catch {
    return null;
  }

  const stage = (parsed.stage ?? 'discovery_open') as IntentStage;
  const equipmentRaw = Array.isArray(parsed.equipment_mentioned)
    ? parsed.equipment_mentioned
    : [];
  const equipment = equipmentRaw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .slice(0, 12);

  return {
    stage,
    prior_assistant_recommended:
      typeof parsed.prior_assistant_recommended === 'boolean'
        ? parsed.prior_assistant_recommended
        : fallbackPriorRec,
    equipment_mentioned: equipment,
    destination_hint:
      parsed.destination_hint === 'cuba' || parsed.destination_hint === 'usa'
        ? parsed.destination_hint
        : null,
    language: parsed.language === 'en' ? 'en' : 'es',
    needs_handoff: !!parsed.needs_handoff,
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 280) : '',
  };
}

/**
 * Classify the customer's intent using Haiku 4.5.
 * Returns null on failure / timeout — caller treats as "no hint" and proceeds.
 */
export async function classifyIntent(
  history: Message[],
  newUserMessage: string
): Promise<IntentClassification | null> {
  const recent = history.slice(-8);
  const lastAssistantHadRec = lastAssistantHadRecommendation(history);

  const thread = recent
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres un clasificador de intención para Sol, un agente de ventas de WhatsApp (Oiikon, energía solar para Cuba/USA). Lee el contexto reciente y el último mensaje del cliente. Devuelve SOLO JSON válido.

Contexto reciente:
${thread || '(conversación nueva)'}

Último mensaje del CLIENTE:
"""
${newUserMessage}
"""

¿Sol ya envió una recomendación con precio + link en el último turno? ${lastAssistantHadRec ? 'SÍ' : 'NO'}

Devuelve SOLO este JSON:
{
  "stage": "greeting" | "discovery_open" | "equipment_listed" | "price_asked" | "ready_to_buy" | "objection" | "logistics" | "vague_followup" | "off_topic",
  "prior_assistant_recommended": ${lastAssistantHadRec},
  "equipment_mentioned": ["nevera", "ventilador", ...],
  "destination_hint": "cuba" | "usa" | null,
  "language": "es" | "en",
  "needs_handoff": false,
  "notes": "1 oración: qué dijo el cliente y qué debería hacer Sol"
}

Reglas para "stage":
- "greeting" — hola, buenos días, primer contacto sin tema.
- "discovery_open" — cliente plantea necesidad sin enumerar equipos ("necesito algo para los apagones").
- "equipment_listed" — cliente nombró aparatos concretos (nevera, ventilador, TV, luces, A/C, etc.) en este turno o el anterior.
- "price_asked" — pidió precio o catálogo sin contexto suficiente.
- "ready_to_buy" — "me interesa", "lo quiero", "cómo pago", "ok lo llevo".
- "objection" — duda sobre precio, garantía, confianza, demora, autenticidad.
- "logistics" — preguntó por envío, aduana, pago, tiempo de entrega, instalación.
- "vague_followup" — respondió a Sol con info ambigua ("algún que otro", "depende", "más o menos").
- "off_topic" — mensaje no relacionado al flujo de venta.

Reglas para "equipment_mentioned":
- Lista normalizada en singular minúscula (nevera, ventilador, tv, luces led, aire acondicionado, lavadora, microondas, computadora, router, freezer, bomba de agua).
- Incluye TODO lo mencionado en los últimos turnos del cliente, no solo el último mensaje.
- Vacío si no hay equipos explícitos.

Reglas para "needs_handoff":
- true si el cliente pide hablar con humano, dice "déjenme con una persona", o si la situación claramente requiere operador (queja seria, factura específica, problema de envío de orden existente).
- Si dudas, false.

Devuelve SOLO el JSON. Sin markdown. Sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: CLASSIFIER_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: CLASSIFIER_TIMEOUT_MS }
    );

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as Partial<IntentClassification>;

    const stage = (parsed.stage ?? 'discovery_open') as IntentStage;
    const equipmentRaw = Array.isArray(parsed.equipment_mentioned)
      ? parsed.equipment_mentioned
      : [];
    const equipment = equipmentRaw
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0)
      .slice(0, 12);

    return {
      stage,
      prior_assistant_recommended: !!parsed.prior_assistant_recommended || lastAssistantHadRec,
      equipment_mentioned: equipment,
      destination_hint:
        parsed.destination_hint === 'cuba' || parsed.destination_hint === 'usa'
          ? parsed.destination_hint
          : null,
      language: parsed.language === 'en' ? 'en' : 'es',
      needs_handoff: !!parsed.needs_handoff,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 280) : '',
    };
  } catch (err) {
    console.warn('[classifyIntent] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Render a compact hint block for injection into Sol's system prompt.
 * Empty string if classification is null.
 */
export function formatIntentHintForPrompt(intent: IntentClassification | null): string {
  if (!intent) return '';

  const stageGuidance = STAGE_HINTS[intent.stage] ?? '';
  const equipment =
    intent.equipment_mentioned.length > 0
      ? intent.equipment_mentioned.join(', ')
      : '(ninguno enumerado)';
  const destination = intent.destination_hint ?? 'sin determinar';
  const priorRecLine = intent.prior_assistant_recommended
    ? 'SÍ — está PROHIBIDO hacer preguntas de descubrimiento ahora. Solo cierre permitido ("¿Lo ordenamos?", "¿Alguna duda antes de ordenar?").'
    : 'NO';

  return `
<INTENT_CLASSIFIER>
Etapa detectada: ${intent.stage}
Guía para esta etapa: ${stageGuidance}
Sol ya recomendó con precio + link en el turno anterior: ${priorRecLine}
Equipos mencionados por el cliente (acumulado): ${equipment}
Destino del envío: ${destination}
Idioma del cliente: ${intent.language}
Notas: ${intent.notes || '(sin notas)'}
</INTENT_CLASSIFIER>
`.trim();
}
