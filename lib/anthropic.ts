import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Message, CustomerProfile, CustomerProfileFact } from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;

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
}

/**
 * Call Claude to generate Sol's response.
 * Returns the customer-facing message and any detected handoff reason.
 */
export async function generateSolResponse(
  conversationHistory: Message[],
  newUserMessage: string,
  productCatalog: string,
  knowledgeBase = '',
  customerProfilePrompt = ''
): Promise<SolResponse> {
  const basePrompt = getAgentPrompt();

  const systemPrompt = `${basePrompt}

${productCatalog}
${knowledgeBase}
${customerProfilePrompt}

FECHA ACTUAL: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
`;

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

  const customerMessage = rawText.replace(/\[HANDOFF:\s*[^\]]+\]/gi, '').trim();

  return { message: customerMessage, handoffReason };
}

// ============================================================
// Automatic learning: customer profile + KB suggestions
// ============================================================

/**
 * Extract per-customer facts from a conversation thread.
 * Strict rule: only facts the customer literally stated.
 */
export async function extractCustomerFacts(
  history: Message[],
  existingProfile: CustomerProfile | null
): Promise<{
  display_name?: string | null;
  language?: string | null;
  summary?: string | null;
  facts?: CustomerProfileFact[];
} | null> {
  if (history.length < 3) return null;

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
  "new_facts": string[]
}

Reglas:
- "display_name": solo si el cliente dijo claramente su nombre.
- "language": "es" si el cliente escribe en español, "en" si en inglés, null si ambiguo.
- "summary": máximo 200 caracteres, resumen neutral de quién es el cliente y qué busca (p.ej. "Cliente en Miami comprando para familia en Cuba; interesado en estación portátil para nevera y luces").
- "new_facts": hechos concretos que el cliente mencionó y que NO aparecen ya en la lista de hechos previos. Ejemplos: "Vive en Miami", "Compra para su madre en Santiago de Cuba", "Su familia tiene nevera vieja y ventilador", "Presupuesto cerca de $800". NO incluyas hechos genéricos o inferidos.
- Si no hay nada nuevo que agregar, devuelve {"display_name": null, "language": null, "summary": null, "new_facts": []}.

Hechos ya conocidos (no los repitas):
${existingFactsText || '(ninguno)'}

Conversación:
${thread}

Devuelve SOLO el JSON, sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as {
      display_name: string | null;
      language: string | null;
      summary: string | null;
      new_facts: string[];
    };

    const now = new Date().toISOString();
    const existingFacts = existingProfile?.facts ?? [];
    const newFactObjects: CustomerProfileFact[] = (parsed.new_facts ?? [])
      .filter((f) => typeof f === 'string' && f.trim().length > 0)
      .map((f) => ({ fact: f.trim(), source_msg_id: null, verified_at: now }));

    const mergedFacts = [...existingFacts, ...newFactObjects].slice(-40);

    return {
      display_name: parsed.display_name ?? existingProfile?.display_name ?? null,
      language: parsed.language ?? existingProfile?.language ?? null,
      summary: parsed.summary ?? existingProfile?.summary ?? null,
      facts: mergedFacts,
    };
  } catch (err) {
    console.warn('[extractCustomerFacts] failed:', err);
    return null;
  }
}

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
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
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
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
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
