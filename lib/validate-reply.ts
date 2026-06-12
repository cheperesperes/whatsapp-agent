/**
 * Pre-send reply validator — the deterministic gate every Sol-generated
 * message passes through right before it reaches a customer.
 *
 * Why this exists: AGENT_PROMPT.md is probabilistic guidance — the model
 * follows it almost always, but "almost" is how an out-of-stock E1000LFP got
 * pitched with a price and a buy link on 2026-06-11. The handful of rules
 * that carry money or compliance risk need a guarantee, and a guarantee only
 * comes from code that runs on the final text. This module is that code.
 *
 * What it enforces (deterministic, no LLM):
 *   1. oos_product_pitch  — a paragraph that PITCHES (price or product link)
 *      an out-of-stock or discontinued SKU is dropped. Honest availability
 *      disclosures ("está agotado, regresa el 15") are kept — the check
 *      skips paragraphs that contain agotado/out-of-stock wording.
 *   2. fake_payment_link  — a paypal.com/checkoutnow URL the MODEL wrote
 *      itself (instead of emitting the [[PAYLINK]] marker for the server to
 *      fulfil) is stripped. Callers pass the URLs found in the pre-swap text
 *      (always hallucinated), or forbidAllPaymentUrls for channels that never
 *      build pay-links (web widget, nudge crons).
 *   3. residual_marker    — leftover [[PAYLINK]]/[SEND_IMAGE] tags stripped
 *      (the webhook already does this; centralizing covers web chat + crons).
 *   4. delivery_promise   — a concrete day-count tied to delivery wording
 *      ("llega en 5 días"). LOG-ONLY: phrasing varies too much to auto-edit
 *      safely; the violation surfaces in logs/metrics so the prompt can be
 *      tightened. Runtime claims ("2 días sin recargar") don't match.
 *
 * Design rules:
 *   • Validation NEVER throws — a validator crash must not block a sale.
 *   • Edits are paragraph-level drops or URL strips, never rewording.
 *   • If everything gets dropped, a safe language-matched line is returned
 *     so the customer never receives an empty message.
 */

import type { AgentProduct } from '@/lib/types';

export type ViolationRule =
  | 'oos_product_pitch'
  | 'fake_payment_link'
  | 'residual_marker'
  | 'delivery_promise';

export interface ReplyViolation {
  rule: ViolationRule;
  detail: string;
}

export interface ValidatedReply {
  text: string;
  violations: ReplyViolation[];
  /** OOS/discontinued SKUs whose pitch was blocked — callers that dispatch
   * product photos should drop these SKUs from their image queue too. */
  blockedSkus: string[];
}

export interface ValidateOptions {
  /** Checkout URLs the model wrote itself (extracted from the PRE-pay-link-
   * swap text) — these are always hallucinated and get stripped. */
  hallucinatedPaymentUrls?: string[];
  /** Treat ANY checkout URL as fake. For channels where no pay-link builder
   * runs (web widget, nudge crons) a checkout URL can only be invented. */
  forbidAllPaymentUrls?: boolean;
  language?: 'es' | 'en' | 'fr' | 'ht';
}

/** Discontinued models (no resupply — Ed's 2026-06-11 warehouse update).
 * Belt-and-braces duplicate of the prompt + catalog: even if these rows are
 * deleted from the catalog (and stop carrying in_stock=false), they can
 * never be pitched. Keep in sync with AGENT_PROMPT "MODELOS DESCONTINUADOS". */
const DISCONTINUED_SKUS = ['E1000LFP', 'E1500LFP', 'F1000LFP'];

/** Big fixed-system categories we drop-ship from suppliers. When OOS these are a
 * consultative SPECIAL ORDER (Sol sizes them, quotes an indicative price, routes
 * to a human for a firm quote), NOT a blocked pitch — so they're exempt from the
 * OOS paragraph-drop below. A real pay-link still can't form (buildPayLink rejects
 * OOS) and any hallucinated checkout URL is stripped by the fake_payment_link rule,
 * so allowing the consultation paragraph carries no payment risk. Keep in sync with
 * SPECIAL_ORDER_CATEGORIES in lib/supabase.ts. */
const SPECIAL_ORDER_CATEGORIES = new Set(['inverter', 'battery', 'sistemas-solares-todo-en-uno']);

const CHECKOUT_URL_RE = /https?:\/\/(?:www\.)?paypal\.com\/checkoutnow[^\s)\]]*/gi;
const MARKER_RE = /\[\[?\s*(SEND_IMAGE|PAYLINK|PRICEMATCH)\b[^\]]*\]\]?/gi;
const PRICE_RE = /\$\s?\d[\d.,]*/;
const PRODUCT_LINK_RE = /https?:\/\/(?:www\.)?oiikon\.com\/product\//i;

/** Words that mark a paragraph as an HONEST availability disclosure rather
 * than a pitch — those paragraphs are allowed to name an OOS SKU (and even
 * its price) while telling the customer it isn't available. es/en/fr/ht. */
const DISCLOSURE_RE =
  /agotado|out of stock|sold out|sin stock|no disponible|not available|restock|regresa|vuelve|back in stock|épuisé|en rupture|fini|pa disponib/i;

/** Concrete day-count adjacent to delivery wording (either order), within
 * the same sentence-ish span. Deliberately narrow: runtime claims like
 * "2 días sin recargar" have no delivery word in range and don't match. */
const DELIVERY_PROMISE_RE =
  /(?:\b(?:entrega|llega\w*|recib\w*|env[ií]o|enviamos|deliver\w*|arriv\w*|shipping|ships?)\b[^.\n]{0,40}\b\d+\s*(?:a\s+\d+\s+)?(?:d[ií]as?|days?)\b)|(?:\b\d+\s*(?:a\s+\d+\s+)?(?:d[ií]as?|days?)\b[^.\n]{0,40}\b(?:entrega|llega\w*|recib\w*|env[ií]o|deliver\w*|arriv\w*|shipping|ships?)\b)/i;

const FALLBACK_LINE: Record<'es' | 'en' | 'fr' | 'ht', string> = {
  es: 'Déjeme confirmar la disponibilidad de ese equipo y le escribo enseguida 🙏 ¿Hay algo más en lo que le pueda ayudar mientras tanto?',
  en: 'Let me double-check availability on that unit and get right back to you 🙏 Anything else I can help with in the meantime?',
  fr: 'Laissez-moi vérifier la disponibilité de cet équipement et je reviens vers vous tout de suite 🙏',
  ht: 'Kite m verifye disponiblite aparèy sa a epi m ap tounen vin jwenn ou touswit 🙏',
};

/** Normalize a URL for comparison (trim trailing punctuation a regex might
 * have captured or the model might have appended). */
function normalizeUrl(u: string): string {
  return u.replace(/[.,;:!?)\]]+$/, '').trim();
}

/** Extract checkout URLs from a text — exported so callers can collect the
 * hallucinated set from the PRE-swap model output. */
export function extractCheckoutUrls(text: string): string[] {
  return (text.match(CHECKOUT_URL_RE) ?? []).map(normalizeUrl);
}

export function validateSolReply(
  rawText: string,
  catalog: AgentProduct[],
  opts: ValidateOptions = {}
): ValidatedReply {
  const violations: ReplyViolation[] = [];
  const blockedSkus: string[] = [];
  const lang = opts.language ?? 'es';

  try {
    let text = rawText ?? '';

    // 3. Residual internal markers — strip unconditionally.
    if (MARKER_RE.test(text)) {
      violations.push({ rule: 'residual_marker', detail: 'stripped leftover [[PAYLINK]]/[SEND_IMAGE] tag' });
      text = text.replace(MARKER_RE, '');
    }
    MARKER_RE.lastIndex = 0;

    // 2. Fake payment links.
    const found = extractCheckoutUrls(text);
    if (found.length > 0) {
      const hallucinated = new Set((opts.hallucinatedPaymentUrls ?? []).map(normalizeUrl));
      const fakes = found.filter((u) => opts.forbidAllPaymentUrls || hallucinated.has(u));
      for (const fake of fakes) {
        violations.push({ rule: 'fake_payment_link', detail: fake.slice(0, 80) });
        // Strip every occurrence (split/join avoids regex-escaping the URL).
        text = text.split(fake).join('').split(normalizeUrl(fake)).join('');
      }
    }

    // 1. OOS / discontinued product pitch — paragraph-level drop. Special-order
    // categories (big fixed systems) are EXEMPT when OOS — those are a consultative
    // special order, not a blocked pitch (see SPECIAL_ORDER_CATEGORIES). Discontinued
    // SKUs are blocked unconditionally regardless of category.
    const oosSkus = new Set<string>(DISCONTINUED_SKUS.map((s) => s.toUpperCase()));
    for (const p of catalog) {
      if (p && p.in_stock === false && p.sku && !SPECIAL_ORDER_CATEGORIES.has(p.category)) {
        oosSkus.add(p.sku.toUpperCase());
      }
    }
    if (oosSkus.size > 0) {
      const paragraphs = text.split(/\n{2,}/);
      const kept: string[] = [];
      for (const para of paragraphs) {
        const upper = para.toUpperCase();
        const mentioned = [...oosSkus].filter((sku) => upper.includes(sku));
        const isPitch =
          mentioned.length > 0 &&
          (PRICE_RE.test(para) || PRODUCT_LINK_RE.test(para)) &&
          !DISCLOSURE_RE.test(para);
        if (isPitch) {
          violations.push({
            rule: 'oos_product_pitch',
            detail: `${mentioned.join('+')} pitched with price/link — paragraph dropped`,
          });
          blockedSkus.push(...mentioned);
          continue;
        }
        kept.push(para);
      }
      if (violations.some((v) => v.rule === 'oos_product_pitch')) {
        text = kept.join('\n\n');
      }
    }

    // 4. Delivery-date promise — log-only (no text edit).
    if (DELIVERY_PROMISE_RE.test(text)) {
      violations.push({ rule: 'delivery_promise', detail: 'concrete day-count near delivery wording (log-only)' });
    }

    // Tidy whatever the strips left behind.
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) text = FALLBACK_LINE[lang];

    return { text, violations, blockedSkus };
  } catch (err) {
    // A validator bug must never block a customer reply — return the input.
    console.error('[VALIDATOR] internal error (reply passed through unmodified):', err);
    return { text: rawText, violations, blockedSkus };
  }
}
