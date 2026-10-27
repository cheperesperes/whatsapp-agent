// ============================================================
// Model configuration — one place for every Claude model Sol uses.
// ============================================================
// Override on Vercel without a deploy:
//   SOL_MODEL         customer-facing replies (default: claude-sonnet-5-5)
//   SOL_HELPER_MODEL  classifier / extraction / lead scoring (default: claude-haiku-5-5)
//   SOL_REVIEW_MODEL  nightly interaction review + coaching (default: SOL_MODEL)
// Rollback = set SOL_MODEL=claude-sonnet-4-6 and SOL_HELPER_MODEL=claude-haiku-4-5-20251001.

export const SOL_MODEL = process.env.SOL_MODEL?.trim() || 'claude-sonnet-5-5';
export const HELPER_MODEL = process.env.SOL_HELPER_MODEL?.trim() || 'claude-haiku-5-5';
export const REVIEW_MODEL = process.env.SOL_REVIEW_MODEL?.trim() || SOL_MODEL;

/**
 * Spread into every messages.create() call. The 5.5 models think by default
 * (adaptive thinking) and, with a small max_tokens, spend the whole budget
 * on the thinking block — the reply then has NO text block (prod incident
 * 2026-10-27: "stop=max_tokens blocks=thinking" on every Sol reply). Sol's
 * answers are short, latency-bound chat turns: thinking off is the right
 * default. The SDK pinned here predates the field, hence the cast at use.
 */
// The API rejects { type: 'disabled' } on 5.5 models and asks for 'between_tools'
// ("the model does not think before responding" — verbatim from the 400 error).
// The pinned SDK's types predate 'between_tools'; the cast keeps tsc happy while the
// wire value is exactly what the API asked for.
export const THINKING_OFF = { thinking: { type: 'between_tools' } } as unknown as { thinking: { type: 'disabled' } };
