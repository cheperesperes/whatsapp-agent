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
