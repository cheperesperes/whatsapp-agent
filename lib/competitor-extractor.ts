import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Competitor mention extractor — anonymous collective learning.
//
// Runs on each incoming user message (fire-and-forget from the webhook).
// Uses Haiku to detect mentions of Amazon / Alibaba / Bluetti / EcoFlow / etc.
// If detected, persists the signal to `competitor_mentions` with NO PII:
// no phone, no conversation_id, no customer name. Just: which competitor,
// which product (if resolvable), what price, what language, when.
//
// Sol later cites aggregated stats ("clientes dicen que Amazon anda cerca
// de $215") instead of guessing — more honest comparisons, zero privacy debt.
// ─────────────────────────────────────────────────────────────────────────────

interface Product {
  sku: string;
  name: string;
}

interface ExtractedMention {
  competitor_name: string;
  product_sku: string | null;
  mentioned_price_usd: number | null;
  original_price: number | null;
  original_currency: string | null;
  context_summary: string;
  language: 'es' | 'en';
}

/**
 * Fast lexical pre-filter. If the message contains no competitor keywords,
 * skip the Haiku call entirely — saves ~$0.0001 × N messages and avoids
 * burning tokens on "ok gracias" type replies.
 */
function containsCompetitorHint(message: string): boolean {
  const lc = message.toLowerCase();
  const hints = [
    'amazon', 'alibaba', 'aliexpress', 'temu', 'shein',
    'bluetti', 'ecoflow', 'eco flow', 'jackery', 'anker', 'solix',
    'goal zero', 'goalzero', 'renogy', 'bmz',
    'ebay', 'walmart', 'home depot', 'costco',
    'más barato', 'mas barato', 'cheaper', 'lo consigo en', 'lo veo en',
    'vi en ', 'vi un ', 'vi una ', 'en otra tienda',
  ];
  return hints.some((h) => lc.includes(h));
}

/**
 * Extract a competitor mention from a user message, or return null if
 * there is no mention. Never throws — a failed extraction is a no-op.
 *
 * @param message   Raw customer message text.
 * @param products  Active catalog for SKU resolution. Pass only sku+name
 *                  to keep the Haiku prompt small.
 * @param recentContext  Last 2–3 user messages (optional). Helps attribute
 *                  a price mention to the product being discussed.
 */
export async function extractCompetitorMention(
  message: string,
  products: Product[],
  recentContext: string[] = []
): Promise<ExtractedMention | null> {
  if (!message?.trim()) return null;
  if (!containsCompetitorHint(message)) return null;

  const catalogBlock = products
    .slice(0, 40)
    .map((p) => `- ${p.sku} — ${p.name}`)
    .join('\n');

  const contextBlock = recentContext.length > 0
    ? `\n\nMensajes anteriores del cliente (contexto):\n${recentContext.map((m, i) => `[${i + 1}] ${m}`).join('\n')}`
    : '';

  const anthropic = new Anthropic();

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Extrae si el siguiente mensaje de un cliente menciona un competidor (Amazon, Alibaba, Bluetti, EcoFlow, Jackery, Anker, Temu, cualquier otra tienda/marca que compita con Oiikon).

Responde SOLO con JSON válido. Si NO hay mención, responde exactamente: null

Si SÍ hay mención, responde:
{
  "competitor_name": "nombre en minúsculas (ej: amazon, alibaba, bluetti)",
  "product_sku": "SKU del catálogo abajo si se puede inferir, o null",
  "mentioned_price_usd": número en USD si el cliente dio un precio, o null,
  "original_price": número original si mencionó otra moneda, o null,
  "original_currency": "código ISO 4217 si no es USD (MXN, ARS, etc), o null",
  "context_summary": "una oración muy corta en español que resume qué dijo el cliente",
  "language": "es o en"
}

Catálogo actual (para resolver SKU):
${catalogBlock}
${contextBlock}

Mensaje del cliente:
"""
${message}
"""`,
      },
    ],
  });

  const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : '';
  if (!text || text === 'null') return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedMention;
    if (!parsed?.competitor_name) return null;
    parsed.competitor_name = parsed.competitor_name.toLowerCase().trim();
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a mention. NO PII — the caller must not pass phone or conversation_id.
 * Failures are swallowed (logged) so they never block the Sol response path.
 */
export async function persistMention(mention: ExtractedMention): Promise<void> {
  try {
    const sb = createServiceClient();
    const { error } = await sb.from('competitor_mentions').insert({
      product_sku: mention.product_sku,
      competitor_name: mention.competitor_name,
      mentioned_price_usd: mention.mentioned_price_usd,
      original_price: mention.original_price,
      original_currency: mention.original_currency,
      context_summary: mention.context_summary?.slice(0, 300),
      language: mention.language ?? 'es',
    });
    if (error) console.warn('[competitor-extractor] insert failed:', error.message);
  } catch (err) {
    console.warn('[competitor-extractor] persist error:', err instanceof Error ? err.message : err);
  }
}

/**
 * One-shot: extract + persist. Fire-and-forget friendly — the caller can
 * `void extractAndPersist(...)` without awaiting.
 */
export async function extractAndPersist(
  message: string,
  products: Product[],
  recentContext: string[] = []
): Promise<void> {
  try {
    const mention = await extractCompetitorMention(message, products, recentContext);
    if (mention) await persistMention(mention);
  } catch (err) {
    console.warn('[competitor-extractor] extractAndPersist error:', err instanceof Error ? err.message : err);
  }
}
