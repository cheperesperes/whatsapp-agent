/**
 * Claude model IDs used across the app — one place to change them.
 *
 * Each can be overridden with a Vercel env var, so a model can be rolled back
 * (or trialled) without a code change: set the var and redeploy.
 *
 *   SOL_MODEL     — Sol's customer replies (WhatsApp + web widget)
 *   REVIEW_MODEL  — daily interaction review / coaching, video checks, long-form marketing copy
 *   FAST_MODEL    — background extractors, classifier, competitor parsing, short marketing tasks
 *
 * Rollback values that still work with this code: claude-sonnet-4-6 / claude-haiku-4-5-20251001.
 *
 * Current Claude models: https://platform.claude.com/docs/en/models/overview
 * Lifecycle / retirement dates: https://platform.claude.com/docs/en/about-claude/model-deprecations
 */
export const SOL_MODEL = process.env.SOL_MODEL || 'claude-sonnet-5-5';
export const REVIEW_MODEL = process.env.REVIEW_MODEL || 'claude-sonnet-5-5';
export const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-5-5';

/**
 * Per-model request adjustments for the 5.x generation. Older models get the
 * params unchanged, so an env rollback to 4.x keeps working.
 *
 * From Anthropic's migration guides (2026):
 * - Sonnet 5.5 runs adaptive thinking by default, and thinking counts toward
 *   max_tokens. Sol has no tools, so `thinking: {type: 'between_tools'}` turns
 *   off up-front thinking — same behavior, latency and cost profile as 4.6.
 *   https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
 * - Haiku 5.5 has no off switch; effort 'low' lets it skip thinking on simple
 *   requests, and max_tokens gets headroom so thinking can't eat the answer.
 *   https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 * - Both use a tokenizer that counts ~30% more tokens for the same text, so
 *   max_tokens is scaled to keep the same reply length cap.
 */
export function claudeParams<T extends { model: string; max_tokens: number }>(params: T): T {
  const model = params.model;
  const scaled = Math.ceil(params.max_tokens * 1.3);
  if (/^claude-(sonnet|opus)-5/.test(model)) {
    return { ...params, max_tokens: scaled, thinking: { type: 'between_tools' } } as T;
  }
  if (/^claude-haiku-5/.test(model)) {
    return { ...params, max_tokens: scaled + 2048, output_config: { effort: 'low' } } as T;
  }
  return params;
}

/**
 * The reply text of a Messages API response. On 5.x models a response can
 * START with thinking blocks, so `content[0].text` is not safe — select blocks
 * by type instead. Returns '' when there is no text (e.g. stopped at max_tokens
 * after thinking).
 */
export function textOf(response: { content: ReadonlyArray<{ type: string }> }): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}
