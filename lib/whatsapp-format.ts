/**
 * WhatsApp output normalizer — the deterministic last-line-of-defense before
 * Sol's reply goes to the customer.
 *
 * The system prompt tells Sol to use WhatsApp-native markup (`*bold*`,
 * `~strike~`, no tables). But prompts drift, caches serve stale versions,
 * and no amount of "NEVER USE `**`" reinforcement keeps the model at 100%.
 * This module fixes the 3 patterns that render as visible broken code in
 * WhatsApp — so even when the prompt fails, the customer never sees it.
 *
 *   `**bold**`   → `*bold*`
 *   `~~strike~~` → `~strike~`
 *   Markdown tables (`| col | col |\n|---|---|`) → logged but NOT auto-fixed
 *     (rewriting a table safely requires understanding semantics; we surface
 *     the occurrence so we can catch & patch the prompt, not silently paper
 *     over it).
 *
 * Returns the cleaned text + a list of fix codes for observability. Callers
 * should log the fixes so we can track violation frequency over time and
 * declare victory when it hits zero.
 */

export type FormatFixCode =
  | 'double_asterisk'
  | 'double_tilde'
  | 'markdown_table_detected';

export type NormalizeResult = {
  text: string;
  fixes: FormatFixCode[];
};

// Greedy match within a "bold span": `**…**` where the interior has no `*`.
// This is intentionally conservative — we won't try to fix pathological cases
// like `**a*b**` (where a stray asterisk sits inside). Those are rare and
// fixing them wrong is worse than leaving them alone.
const DOUBLE_ASTERISK_RE = /\*\*([^*\n]+?)\*\*/g;
const DOUBLE_TILDE_RE = /~~([^~\n]+?)~~/g;

// A Markdown table is a header row followed by a separator row:
//   | Col | Col |
//   |-----|-----|
// We look for the separator line pattern. This is the single unambiguous
// signal — `|` alone appears in plain text ("the E1000 | 1024Wh" etc.),
// so we need the `---` separator to be confident.
const MD_TABLE_SEPARATOR_RE = /^\s*\|\s*:?-{2,}.*\|\s*$/m;

export function normalizeWhatsAppFormatting(input: string): NormalizeResult {
  if (!input) return { text: input, fixes: [] };

  const fixes: FormatFixCode[] = [];
  let out = input;

  if (DOUBLE_ASTERISK_RE.test(out)) {
    out = out.replace(DOUBLE_ASTERISK_RE, '*$1*');
    fixes.push('double_asterisk');
  }

  if (DOUBLE_TILDE_RE.test(out)) {
    out = out.replace(DOUBLE_TILDE_RE, '~$1~');
    fixes.push('double_tilde');
  }

  if (MD_TABLE_SEPARATOR_RE.test(out)) {
    fixes.push('markdown_table_detected');
  }

  return { text: out, fixes };
}
