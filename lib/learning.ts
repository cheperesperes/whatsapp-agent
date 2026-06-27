import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from './supabase';
import type { Message } from './types';

// ============================================================
// Sol interaction-learning loop.
//
// Daily cron (/api/cron/sol-learning) reviews recent conversations with a
// Claude judge tuned to an "Amazon top seller" mindset (customer obsession,
// earn trust, ownership, natural close, human warmth), stores one review per
// conversation per day in `sol_interaction_reviews`, then consolidates the
// review takeaways into at most MAX_ACTIVE_LEARNINGS behavior directives in
// `sol_learnings`. Active directives are injected into Sol's system prompt
// via getLearnedBehaviorsBlock() so she actually adapts — the loop closes.
// ============================================================

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Same model Sol replies with. Reviews run offline in a cron (not in the
// reply path), so we can afford the better judge over Haiku.
const REVIEW_MODEL = 'claude-sonnet-4-6';
const REVIEW_TIMEOUT_MS = 30_000;

export const MAX_ACTIVE_LEARNINGS = 8;

export type ReviewDimensionId =
  | 'calidez_humana'
  | 'obsesion_cliente'
  | 'confianza'
  | 'proactividad'
  | 'cierre_natural'
  | 'idioma_tono';

export const REVIEW_DIMENSION_LABELS: Record<ReviewDimensionId, string> = {
  calidez_humana: 'Calidez humana (suena a persona real)',
  obsesion_cliente: 'Obsesión por el cliente (resuelve la necesidad real)',
  confianza: 'Confianza (preciso, honesto, sin sobreprometer)',
  proactividad: 'Proactividad (se adelanta, da el siguiente paso)',
  cierre_natural: 'Cierre natural (avanza la venta sin presionar)',
  idioma_tono: 'Idioma y tono (idioma correcto, fraseo nativo)',
};

const REVIEW_DIMENSION_IDS: ReviewDimensionId[] = [
  'calidez_humana',
  'obsesion_cliente',
  'confianza',
  'proactividad',
  'cierre_natural',
  'idioma_tono',
];

export const LEARNING_CATEGORIES = [
  'apertura',
  'descubrimiento',
  'recomendacion',
  'objeciones',
  'cierre',
  'tono',
  'general',
] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

export interface CandidateLearning {
  directive: string;
  category: string;
  rationale: string;
}

export interface InteractionReview {
  overall_score: number;
  scores: Record<ReviewDimensionId, number>;
  customer_sentiment: 'contento' | 'neutral' | 'frustrado';
  what_worked: string;
  what_failed: string;
  missed_opportunity: string | null;
  candidate_learnings: CandidateLearning[];
}

export interface SolLearning {
  id: string;
  directive: string;
  category: string;
  rationale: string | null;
  status: 'active' | 'retired';
  source: 'auto' | 'manual';
  times_reinforced: number;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Hard guardrails — standing house rules the learning loop must NEVER
// override, no matter what a review suggests. Enforced twice: stated in
// both AI prompts AND regex-screened before any directive is persisted.
// ------------------------------------------------------------

export const LEARNING_HARD_CONSTRAINTS = `REGLAS DURAS (NUNCA propongas aprendizajes que las violen — descártalos):
- NUNCA precios, montos en $, porcentajes de descuento ni códigos de cupón: los precios y ofertas vienen del catálogo del sistema, no del coaching.
- NUNCA tiempos ni fechas de entrega ("llega en X días", "tarda N semanas"). Regla de la casa: no prometer fechas; decir que el pedido se prepara para enviar lo antes posible y que enviamos el tracking.
- NUNCA cambiar las reglas de idioma (español/inglés estricto según el cliente) ni el flujo de pago [[PAYLINK]].
- NUNCA mencionar Cuba ni envíos fuera de USA.
- Nada específico de UN cliente (nombres, ciudades, presupuestos): solo comportamientos generalizables a cualquier conversación.`;

/**
 * Regex screen applied to every directive before it's saved. Belt &
 * suspenders on top of the prompt-level constraints: blocks price amounts,
 * delivery-time promises, Cuba mentions and coupon-looking strings.
 * Exported for unit testing.
 */
export function violatesHardRules(directive: string): boolean {
  const d = directive ?? '';
  return (
    /\b(cuba|cubano|cubana|la isla)\b/i.test(d) ||
    /\$\s?\d/.test(d) ||
    /\b\d+\s*%/.test(d) ||
    // Spelled-out money: "1000 dolares", "mil dólares", "USD 900", "900 usd"
    /\b\d[\d.,]*\s*(d[oó]lar(es)?|dollars?|usd|eur|pesos?)\b/i.test(d) ||
    /\busd\s*\$?\d/i.test(d) ||
    // Delivery time: N days/weeks/hours (incl. bare "48 horas", "72h")
    /\b\d+\s*(d[ií]as?|days?|semanas?|weeks?|h|hrs?|horas?)\b/i.test(d) ||
    /\b(cup[oó]n|coupon|c[oó]digo)\s+[A-Z0-9]{4,}\b/.test(d)
  );
}

function clampScore(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanJsonText(text: string): string {
  return text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
}

// ------------------------------------------------------------
// 1) Per-conversation review (the judge)
// ------------------------------------------------------------

export async function reviewInteraction(
  history: Message[],
  meta: { customerName?: string | null; language?: string | null; channel?: string | null }
): Promise<InteractionReview | null> {
  const userMsgCount = history.filter((m) => m.role === 'user').length;
  if (userMsgCount < 2) return null;

  const thread = history
    .slice(-24)
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'SOL'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres coach de calidad de un equipo de ventas por WhatsApp. Evalúas a Sol (agente de Oiikon, estaciones de energía portátil) con la mentalidad de un TOP SELLER DE AMAZON: obsesión por el cliente, ganar confianza, respuestas rápidas y útiles, ownership del problema, y cierre natural sin presión. La meta es que Sol se sienta HUMANA — cálida, natural, nunca robótica — y que venda como el mejor vendedor de Amazon atendería su tienda.

Evalúa SOLO los mensajes de SOL (al cliente no se le evalúa). Puntúa cada dimensión de 1 a 5 (5 = nivel top seller):

1. calidez_humana — Suena a persona real: saludo cálido, usa el nombre del cliente si lo sabe, refleja el tono y energía del cliente, varía sus frases, emojis con moderación. 1-2 si suena a plantilla, repite muletillas o ignora el tono del cliente.
2. obsesion_cliente — Entendió la necesidad REAL (preguntó lo justo, no interrogatorio), recomendó lo que le sirve AL CLIENTE (no lo más caro), y respondió exactamente lo que se le preguntó antes de pedir nada. APERTURA: premia que en el primer turno haya hecho UNA pregunta de descubrimiento antes de lanzar pitch/precio/link (vomitar precio+link de entrada enfría al cliente — eso baja la nota, no la sube).
3. confianza — Preciso y honesto: nada inventado, no sobrepromete, reconoce límites del equipo cuando aplica, consistente con el catálogo. Como Amazon: la confianza se gana en cada mensaje. Dar el precio de catálogo o el cupón cuando el cliente PREGUNTA es CORRECTO — NO es falta. Solo penaliza precios/cupones INVENTADOS o equivocados (incoherentes con el catálogo).
4. proactividad — Se adelanta: responde Y ofrece el siguiente paso obvio (foto, comparación, link), no deja al cliente colgado, retoma hilos pendientes sin que se lo pidan.
5. cierre_natural — Detecta señales de compra y avanza en el momento correcto: ante señal de compra pidió la logística (estado/dirección) y envió el [[PAYLINK]] del MODELO EXACTO. 1-2 si dejó pasar una señal clara de compra O si presionó cuando no tocaba. ABANDONO: ante duda ("lo voy a pensar") ofreció el pago mensual con Affirm y capturó el contacto (correo/WhatsApp) en vez de limitarse a "tómate tu tiempo". ESCALACIÓN: derivó a un humano solo cuando correspondía (post-venta o caso no-estándar), NUNCA por una duda de venta (precio/specs/"lo pienso").
6. idioma_tono — Responde 100% en el idioma del cliente, con fraseo nativo natural, y longitud proporcional a la pregunta (corta para preguntas simples).

Además:
- "overall_score": 1-10, tu nota global de la interacción como coach exigente. PREMIA que Sol AVANCE LA VENTA — que enganche en el turno 1 y lleve al cliente hacia el link de pago. La cortesía SOLA no basta: un mensaje cálido que no hace avanzar la venta no merece nota alta. El norte es el % de respuesta tras el turno 1 y el % que llega al [[PAYLINK]], no la cortesía.
- "customer_sentiment": cómo terminó el cliente — "contento" | "neutral" | "frustrado".
- "what_worked": 1 oración, lo mejor que hizo Sol (cita o parafrasea).
- "what_failed": 1 oración, la falla más importante ("" si no hubo).
- "missed_opportunity": 1 oración con LA oportunidad de venta o de conexión humana que Sol dejó pasar, o null.
- "candidate_learnings": 0-2 aprendizajes GENERALIZABLES para mejorar a Sol en TODAS las conversaciones futuras. Cada uno: { "directive": instrucción imperativa en español, máx 200 caracteres, accionable en cualquier conversación; "category": "apertura"|"descubrimiento"|"recomendacion"|"objeciones"|"cierre"|"tono"|"general"; "rationale": por qué, máx 120 caracteres }. Si la conversación no enseña nada nuevo, devuelve [].

${LEARNING_HARD_CONSTRAINTS}

Contexto: cliente=${meta.customerName ?? 'desconocido'} · idioma=${meta.language ?? '?'} · canal=${meta.channel ?? 'whatsapp'}

Conversación:
${thread}

Devuelve SOLO JSON válido con esta forma exacta:
{
  "scores": { "calidez_humana": 1-5, "obsesion_cliente": 1-5, "confianza": 1-5, "proactividad": 1-5, "cierre_natural": 1-5, "idioma_tono": 1-5 },
  "overall_score": 1-10,
  "customer_sentiment": "contento" | "neutral" | "frustrado",
  "what_worked": "...",
  "what_failed": "...",
  "missed_opportunity": "..." | null,
  "candidate_learnings": [ { "directive": "...", "category": "...", "rationale": "..." } ]
}
Sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: REVIEW_MODEL,
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: REVIEW_TIMEOUT_MS }
    );
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(cleanJsonText(text)) as Partial<InteractionReview> & {
      scores?: Record<string, unknown>;
    };

    const scores = {} as Record<ReviewDimensionId, number>;
    for (const id of REVIEW_DIMENSION_IDS) {
      scores[id] = clampScore(parsed.scores?.[id], 1, 5, 3);
    }

    const sentiment =
      parsed.customer_sentiment === 'contento' || parsed.customer_sentiment === 'frustrado'
        ? parsed.customer_sentiment
        : 'neutral';

    const candidates = (Array.isArray(parsed.candidate_learnings) ? parsed.candidate_learnings : [])
      .filter(
        (c): c is CandidateLearning =>
          !!c && typeof c.directive === 'string' && c.directive.trim().length > 0
      )
      .map((c) => ({
        directive: c.directive.trim().slice(0, 220),
        category: LEARNING_CATEGORIES.includes(c.category as LearningCategory)
          ? c.category
          : 'general',
        rationale: typeof c.rationale === 'string' ? c.rationale.trim().slice(0, 160) : '',
      }))
      .filter((c) => !violatesHardRules(c.directive))
      .slice(0, 2);

    return {
      overall_score: clampScore(parsed.overall_score, 1, 10, 5),
      scores,
      customer_sentiment: sentiment,
      what_worked: typeof parsed.what_worked === 'string' ? parsed.what_worked.slice(0, 300) : '',
      what_failed: typeof parsed.what_failed === 'string' ? parsed.what_failed.slice(0, 300) : '',
      missed_opportunity:
        typeof parsed.missed_opportunity === 'string' && parsed.missed_opportunity.trim()
          ? parsed.missed_opportunity.slice(0, 300)
          : null,
      candidate_learnings: candidates,
    };
  } catch (err) {
    console.warn('[reviewInteraction] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ------------------------------------------------------------
// 2) Consolidation — today's candidates + existing directives → the
//    single bounded set of active learnings Sol will actually follow.
// ------------------------------------------------------------

export interface ConsolidatedLearning {
  id: string | null; // existing sol_learnings.id when kept, null when new
  directive: string;
  category: string;
  rationale: string;
  reinforced: boolean;
}

export async function consolidateLearnings(args: {
  activeAuto: SolLearning[];
  manual: SolLearning[];
  candidates: CandidateLearning[];
  statsLine: string;
}): Promise<ConsolidatedLearning[] | null> {
  const existingBlock = args.activeAuto.length
    ? args.activeAuto
        .map(
          (l) =>
            `- id=${l.id} [${l.category}, reforzado x${l.times_reinforced}] ${l.directive}`
        )
        .join('\n')
    : '(ninguno)';

  const manualBlock = args.manual.length
    ? args.manual.map((l) => `- ${l.directive}`).join('\n')
    : '(ninguno)';

  const candidatesBlock = args.candidates.length
    ? args.candidates.map((c) => `- [${c.category}] ${c.directive} (${c.rationale})`).join('\n')
    : '(ninguno)';

  const prompt = `Eres el editor del manual de coaching de Sol, un agente de ventas por WhatsApp (Oiikon, estaciones de energía). Mantienes una lista CORTA de directivas de comportamiento que se inyectan en el prompt de Sol todos los días. Mentalidad: top seller de Amazon (obsesión por el cliente, confianza, cierre natural, trato humano).

Hoy: ${args.statsLine}

DIRECTIVAS AUTOMÁTICAS ACTIVAS (puedes mantener, refinar, fusionar o retirar):
${existingBlock}

COACHING MANUAL DEL OPERADOR (contexto — NO las edites ni las repitas en tu salida):
${manualBlock}

CANDIDATOS NUEVOS de las evaluaciones de hoy:
${candidatesBlock}

Tu trabajo: devolver la lista final de directivas automáticas activas (máximo ${MAX_ACTIVE_LEARNINGS}, idealmente 5-7).
Reglas de edición:
- MANTÉN una directiva existente con su mismo id y texto si sigue siendo valiosa (estabilidad > novedad). Marca "reinforced": true si los candidatos de hoy la respaldan.
- FUSIONA candidatos que repiten una directiva existente (mejora levemente el texto solo si queda más claro y accionable).
- AGREGA un candidato nuevo (id=null) solo si enseña algo que la lista no cubre.
- RETIRA (simplemente no la incluyas) la directiva menos valiosa cuando la lista exceda el máximo.
- No dupliques lo que ya dice el coaching manual del operador.
- Cada directiva: imperativa, en español, ≤ 200 caracteres, aplicable a CUALQUIER conversación.

${LEARNING_HARD_CONSTRAINTS}

Devuelve SOLO JSON válido:
{ "learnings": [ { "id": "uuid-existente" | null, "directive": "...", "category": "apertura"|"descubrimiento"|"recomendacion"|"objeciones"|"cierre"|"tono"|"general", "rationale": "...", "reinforced": true|false } ] }
Sin markdown, sin explicación.`;

  try {
    const response = await client.messages.create(
      {
        model: REVIEW_MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: REVIEW_TIMEOUT_MS }
    );
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(cleanJsonText(text)) as {
      learnings?: Array<Partial<ConsolidatedLearning>>;
    };

    const validIds = new Set(args.activeAuto.map((l) => l.id));
    const seen = new Set<string>();
    const out: ConsolidatedLearning[] = [];
    for (const item of parsed.learnings ?? []) {
      if (!item || typeof item.directive !== 'string') continue;
      const directive = item.directive.trim().slice(0, 220);
      if (!directive || violatesHardRules(directive)) continue;
      const key = directive.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: typeof item.id === 'string' && validIds.has(item.id) ? item.id : null,
        directive,
        category: LEARNING_CATEGORIES.includes(item.category as LearningCategory)
          ? (item.category as string)
          : 'general',
        rationale: typeof item.rationale === 'string' ? item.rationale.trim().slice(0, 160) : '',
        reinforced: item.reinforced === true,
      });
      if (out.length >= MAX_ACTIVE_LEARNINGS) break;
    }
    return out;
  } catch (err) {
    console.warn('[consolidateLearnings] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Persist a consolidation result: kept rows are updated, new rows inserted,
 * and active auto rows the consolidator dropped are retired. Manual rows are
 * never touched. Returns the number of active learnings after sync.
 */
export async function syncLearnings(
  activeAuto: SolLearning[],
  consolidated: ConsolidatedLearning[]
): Promise<number> {
  const sb = createServiceClient();
  const now = new Date().toISOString();
  const keptIds = new Set(consolidated.filter((c) => c.id).map((c) => c.id as string));

  for (const old of activeAuto) {
    if (!keptIds.has(old.id)) {
      await sb
        .from('sol_learnings')
        .update({ status: 'retired', updated_at: now })
        .eq('id', old.id);
    }
  }

  for (const item of consolidated) {
    if (item.id) {
      const prev = activeAuto.find((l) => l.id === item.id);
      await sb
        .from('sol_learnings')
        .update({
          directive: item.directive,
          category: item.category,
          rationale: item.rationale || prev?.rationale || null,
          times_reinforced: (prev?.times_reinforced ?? 1) + (item.reinforced ? 1 : 0),
          status: 'active',
          updated_at: now,
        })
        .eq('id', item.id);
    } else {
      await sb.from('sol_learnings').insert({
        directive: item.directive,
        category: item.category,
        rationale: item.rationale || null,
        status: 'active',
        source: 'auto',
        times_reinforced: 1,
      });
    }
  }

  const { count } = await sb
    .from('sol_learnings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  return count ?? consolidated.length;
}

// ------------------------------------------------------------
// 3) Prompt injection — the block Sol reads on every reply.
// ------------------------------------------------------------

let _learningsCache: { value: string; fetchedAt: number } | null = null;
const LEARNINGS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Active learnings formatted as a prompt block, cached in-module for 10
 * minutes (learnings change ~once a day; don't pay a DB read per message).
 * Fails SOFT: any error (including the table not existing yet) returns ''
 * so Sol's reply path is never blocked by the learning loop.
 */
export async function getLearnedBehaviorsBlock(): Promise<string> {
  if (_learningsCache && Date.now() - _learningsCache.fetchedAt < LEARNINGS_CACHE_TTL_MS) {
    return _learningsCache.value;
  }
  try {
    const sb = createServiceClient();
    const { data, error } = await sb
      .from('sol_learnings')
      .select('directive, source')
      .eq('status', 'active')
      .order('source', { ascending: false }) // manual first
      .order('times_reinforced', { ascending: false })
      .limit(MAX_ACTIVE_LEARNINGS + 4);
    if (error) throw error;

    const rows = (data ?? []).filter((r) => !violatesHardRules(r.directive));
    const value = rows.length
      ? [
          '=== COACHING DE VENTAS APRENDIDO (de evaluaciones de conversaciones reales — aplícalo en cada respuesta) ===',
          ...rows.slice(0, MAX_ACTIVE_LEARNINGS + 4).map((r) => `• ${r.directive}`),
        ].join('\n')
      : '';

    _learningsCache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    console.warn('[getLearnedBehaviorsBlock] failed (soft):', err instanceof Error ? err.message : err);
    _learningsCache = { value: '', fetchedAt: Date.now() };
    return '';
  }
}

/** Test/ops helper — drop the in-module cache (e.g. right after a sync). */
export function invalidateLearningsCache(): void {
  _learningsCache = null;
}
