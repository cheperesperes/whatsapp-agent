/**
 * Follow-up message builder for silent warm leads.
 *
 * Background: AGENT_PROMPT.md lines 868-882 claim the system schedules a
 * single gentle nudge 18-24h after a customer receives a full quote
 * (price + link + photo) and goes silent. In practice, no such cron
 * existed — the prompt promised behavior the code didn't deliver, and
 * ~20% of warm leads who would have responded to a nudge never got one.
 * This module is the missing piece.
 *
 * Policy: ONE follow-up, ever. WhatsApp Business Policy only allows
 * free-form messages inside a 24-hour window from the customer's last
 * message. We target 18-24h to stay safely inside that window. After
 * that, it's customer silence final. Respecting that is required for
 * the WhatsApp Business account and — per research Sol itself cites —
 * a second nudge causes opt-outs and hurts the brand.
 *
 * Content template mirrors the prompt's own "Plantilla español/inglés"
 * at lines 875/878 so the customer sees a message that matches what
 * Sol promised it would send.
 */

export interface FollowupInput {
  customerName: string | null;
  lastAssistantContent: string;
  language: 'es' | 'en';
}

// Pay-link nudge supports the four languages Sol speaks (es/en/fr/ht).
export type NudgeLanguage = 'es' | 'en' | 'fr' | 'ht';

export interface PaylinkNudgeInput {
  customerName: string | null;
  lastAssistantContent: string;
  language: NudgeLanguage;
}

/**
 * Regex patterns that match our own follow-up templates. Used to detect
 * whether a prior follow-up has already been sent on this conversation,
 * so the cron never double-nudges.
 *
 * We avoid a dedicated schema column because the templates are distinctive
 * enough ("quería ver si pudo revisar" / "just checking in on") that false
 * positives are near-zero. Sol's normal replies don't use these phrases.
 *
 * The pay-link-nudge openers are included here on purpose: a lead that got
 * a pay-link nudge must NOT also get the generic 18-24h follow-up (that
 * would be two nudges — the exact thing the one-nudge policy forbids).
 * Both crons call hasPriorFollowup, so either nudge suppresses the other.
 */
export const FOLLOWUP_MARKER_PATTERNS: RegExp[] = [
  /quería ver si pudo revisar/i,
  /just checking in on/i,
  // pay-link nudge openers (es/en/fr/ht)
  /¿alguna duda con el pago/i,
  /any questions about (your )?checkout/i,
  /une question sur le paiement/i,
  /èske ou gen kesyon sou peman/i,
];

/**
 * Try to pull a concrete product model identifier from the last assistant
 * message, so the follow-up reads "...el E1500LFP que le recomendé" rather
 * than the vague "...lo que le compartí".
 *
 * Pattern: PECRON/EcoFlow/etc naming ({letter}{3-4 digits}{optional suffix})
 * covers E500LFP, E1000LFP, E1500LFP, E3600LFP, F3000LFP, DELTA, etc.
 * Returns null if no clear model is found; caller falls back to a
 * model-agnostic line.
 */
export function extractProductModel(text: string): string | null {
  if (!text) return null;
  // PECRON-style: "E1500LFP", "F3000LFP" (letter + 3-4 digits + optional suffix)
  const pecronMatch = text.match(/\b([EF]\d{3,4}[A-Z]{0,5})\b/);
  if (pecronMatch) return pecronMatch[1].toUpperCase();
  // EcoFlow-style: "DELTA 2 Max", "DELTA Pro" (word after brand name)
  const deltaMatch = text.match(/\b(DELTA\s+(?:PRO|MAX|\d))\b/i);
  if (deltaMatch) return deltaMatch[1].toUpperCase();
  return null;
}

/**
 * Clean up a display_name before using it in a greeting. Handles:
 *   - Multi-part names → first word only ("Carlos Pérez" → "Carlos")
 *   - ALL CAPS → title case ("CARLOS" → "Carlos")
 *   - Leading/trailing whitespace
 *
 * Returns empty string if name is null/empty — caller falls back to
 * a no-name greeting.
 */
export function formatFirstName(name: string | null | undefined): string {
  if (!name) return '';
  const first = name.trim().split(/\s+/)[0] ?? '';
  if (!first) return '';
  // Title-case: first char upper, rest lower.
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Build a follow-up message, language-aware, model-aware when possible.
 * Matches the templates promised in AGENT_PROMPT.md.
 */
export function buildFollowupDraft(input: FollowupInput): string {
  const { customerName, lastAssistantContent, language } = input;
  const model = extractProductModel(lastAssistantContent);
  const first = formatFirstName(customerName);

  if (language === 'en') {
    const greeting = first ? `Hi ${first}, ` : 'Hi, ';
    const subject = model
      ? `the ${model} I shared yesterday`
      : 'what I shared yesterday';
    return `${greeting}just checking in on ${subject}. Any questions I can clear up? No pressure — happy to help whenever you're ready. 😊`;
  }

  const greeting = first ? `Hola ${first}, ` : 'Hola, ';
  const subject = model
    ? `el ${model} que le recomendé`
    : 'lo que le compartí';
  return `${greeting}quería ver si pudo revisar ${subject}. ¿Alguna duda que le pueda aclarar? Sin compromiso — aquí estoy cuando guste. 😊`;
}

/**
 * True if any of the last N assistant messages look like a follow-up we
 * already sent. Caller passes the raw message rows in any order — we only
 * care whether at least one matches the marker patterns.
 */
export function hasPriorFollowup(
  assistantMessages: Array<{ content: string }>
): boolean {
  return assistantMessages.some((m) =>
    FOLLOWUP_MARKER_PATTERNS.some((p) => p.test(m.content))
  );
}

/**
 * Detect that Sol's message actually delivered a PayPal pay-link — the
 * trigger for the pay-link-abandonment nudge. Matches ONLY the real hosted
 * PayPal URL. Must NOT match the localized "link de pago seguro" / "secure
 * pay link" lead-in phrases, because the SOFT FAILURE fallback (sent when
 * buildPayLink fails — OOS SKU, PayPal error) contains those exact phrases
 * but NO url; matching them would nudge a customer about a link that was
 * never delivered. A successful send always contains the checkoutnow URL.
 */
export const PAYLINK_SENT_RE = /paypal\.com\/checkoutnow|checkoutnow\?token=/i;

/**
 * Build the pay-link-abandonment nudge: the customer asked to buy, Sol sent
 * a pay-link, and they went quiet without paying. Framed as PAYMENT HELP,
 * never "you didn't pay" — we assume friction or a question, not reluctance.
 * Language-aware (es/en/fr/ht); model-aware when the SKU is recoverable.
 * One nudge only (the shared FOLLOWUP_MARKER_PATTERNS enforce that across
 * both crons).
 */
export function buildPaylinkNudgeDraft(input: PaylinkNudgeInput): string {
  const { customerName, lastAssistantContent, language } = input;
  const model = extractProductModel(lastAssistantContent);
  const first = formatFirstName(customerName);

  if (language === 'en') {
    const g = first ? `Hi ${first}, ` : 'Hi, ';
    const what = model ? `the ${model}` : 'your order';
    return `${g}any questions about your checkout for ${what}? Your secure payment link is still active — I'm here if anything came up or you'd like help wrapping it up. 😊`;
  }
  if (language === 'fr') {
    const g = first ? `Bonjour ${first}, ` : 'Bonjour, ';
    const what = model ? `le ${model}` : 'votre commande';
    return `${g}une question sur le paiement de ${what} ? Votre lien de paiement sécurisé est toujours actif — je suis là si quelque chose bloque ou si vous voulez de l'aide pour finaliser. 😊`;
  }
  if (language === 'ht') {
    const g = first ? `Bonjou ${first}, ` : 'Bonjou, ';
    const what = model ? `${model} la` : 'kòmand ou an';
    return `${g}èske ou gen kesyon sou peman ${what}? Lyen peman sekirize ou an toujou aktif — mwen la si gen yon bagay ki bloke oswa si ou vle èd pou fini l. 😊`;
  }
  const g = first ? `Hola ${first}, ` : 'Hola, ';
  const what = model ? `el ${model}` : 'su pedido';
  return `${g}¿alguna duda con el pago de ${what}? Su link de pago seguro sigue activo — aquí estoy si surgió algo o si quiere que le ayude a completarlo. 😊`;
}

// ════════════════════════════════════════════════════════════════════════════
// Sales-pipeline nudge ladder (2026-06-11)
//
// A top seller follows a quoted lead more than once. The ladder, all inside
// the WhatsApp 24h free-form window measured from the CUSTOMER's last
// message:
//
//   touch 1 (2-6h)   quote_nudge        — quoted, went quiet same evening
//                    paylink_nudge      — pay-link sent, didn't pay (existing)
//   touch 2 (18-23h) window_close_nudge — still quiet, last free-form chance
//   day 2-14         manual_chase       — dashboard queue; operator sends
//                                         from the WhatsApp app (the API
//                                         can't free-form outside 24h)
//
// Hard caps: max 2 automated touches per conversation, ≥10h apart, never
// after a reply/order/opt-out/escalation, quiet-hours aware. The ledger
// lives in the sol_followups table (NOT text markers) — every automated
// send inserts a row there, and every cron consults it before sending.
// ════════════════════════════════════════════════════════════════════════════

export type FollowupKind =
  | 'quote_nudge'
  | 'window_close_nudge'
  | 'paylink_nudge'
  | 'manual_chase';

/** An assistant message containing a storefront product link = a quote. Same
 * definition send-followups has always used. */
export const PRODUCT_QUOTE_RE = /https?:\/\/(?:www\.)?oiikon\.com\/product\//i;

/** Max automated nudges per conversation, across all kinds. */
export const MAX_AUTO_NUDGES = 2;
/** Minimum spacing between two automated nudges. */
export const MIN_NUDGE_GAP_HOURS = 10;

export interface QuoteNudgeInput {
  customerName: string | null;
  lastAssistantContent: string;
  language: NudgeLanguage;
  /** Rotates the copy so consecutive leads don't read identical. Any int. */
  variant?: number;
}

/**
 * Touch-1 for a quoted-but-quiet lead (same evening, 2-6h). Asks for the
 * close softly: answer doubts + offer to leave the order ready. Makes NO
 * price/discount/stock claims — those may have changed since the quote.
 */
export function buildQuoteNudgeDraft(input: QuoteNudgeInput): string {
  const { customerName, lastAssistantContent, language } = input;
  const model = extractProductModel(lastAssistantContent);
  const first = formatFirstName(customerName);
  const v = Math.abs(input.variant ?? 0) % 2;

  if (language === 'en') {
    const g = first ? `Hi ${first}, ` : 'Hi, ';
    const what = model ? `the ${model}` : 'the unit I recommended';
    return v === 0
      ? `${g}what did you think of ${what}? Happy to answer any question right away — and if you're ready, I'll set up your secure checkout link so it's done in 2 minutes. 😊`
      : `${g}just circling back on ${what}. Any questions I can clear up? Whenever you're ready I'll get your order link set — no pressure. 😊`;
  }
  if (language === 'fr') {
    const g = first ? `Bonjour ${first}, ` : 'Bonjour, ';
    const what = model ? `le ${model}` : `l'équipement que je vous ai recommandé`;
    return `${g}que pensez-vous de ${what} ? Je réponds à toute question tout de suite — et si vous êtes prêt(e), je vous prépare le lien de paiement sécurisé en 2 minutes. 😊`;
  }
  if (language === 'ht') {
    const g = first ? `Bonjou ${first}, ` : 'Bonjou, ';
    const what = model ? `${model} la` : 'aparèy mwen te rekòmande a';
    return `${g}kisa ou panse de ${what}? M ap reponn nenpòt kesyon touswit — epi si ou pare, m ap prepare lyen peman sekirize ou a nan 2 minit. 😊`;
  }
  const g = first ? `Hola ${first}, ` : 'Hola, ';
  const what = model ? `el ${model}` : 'el equipo que le recomendé';
  return v === 0
    ? `${g}¿qué le pareció ${what}? Cualquier duda se la respondo al momento — y si ya se decidió, se lo dejo listo y queda ordenado en 2 minutos. 😊`
    : `${g}quedé pendiente con ${what}. ¿Le quedó alguna duda que le pueda aclarar? Cuando me diga, se lo dejo listo para ordenar — sin compromiso. 😊`;
}

/**
 * Suggested copy for the MANUAL chase queue (>24h — operator sends it from
 * the WhatsApp app, where a human 1-to-1 message is allowed). No price or
 * discount claims (they may have changed); just reopen + offer help.
 */
export function buildManualChaseDraft(input: {
  customerName: string | null;
  sku: string | null;
  language: 'es' | 'en';
}): string {
  const first = formatFirstName(input.customerName);
  if (input.language === 'en') {
    const g = first ? `Hi ${first}! ` : 'Hi! ';
    const what = input.sku ? `the *${input.sku}*` : 'the power station you were looking at';
    return `${g}It's Sol from Oiikon 😊 A few days ago we talked about ${what} — it's still available. If any question was holding you back, I'll answer it right away, and whenever you're ready I can leave your order set up in 2 minutes. Still interested?`;
  }
  const g = first ? `¡Hola ${first}! ` : '¡Hola! ';
  const what = input.sku ? `el *${input.sku}*` : 'el equipo que estuvo mirando';
  return `${g}Soy Sol de Oiikon 😊 Hace unos días hablamos de ${what} — sigue disponible. Si alguna duda lo detuvo, se la respondo al momento, y cuando guste se lo dejo listo para ordenar en 2 minutos. ¿Le interesa todavía?`;
}
