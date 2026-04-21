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

/**
 * Regex patterns that match our own follow-up templates. Used to detect
 * whether a prior follow-up has already been sent on this conversation,
 * so the cron never double-nudges.
 *
 * We avoid a dedicated schema column because the templates are distinctive
 * enough ("quería ver si pudo revisar" / "just checking in on") that false
 * positives are near-zero. Sol's normal replies don't use these phrases.
 */
export const FOLLOWUP_MARKER_PATTERNS: RegExp[] = [
  /quería ver si pudo revisar/i,
  /just checking in on/i,
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
