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
 * Current Claude models: https://platform.claude.com/docs/en/models/overview
 * Lifecycle / retirement dates: https://platform.claude.com/docs/en/about-claude/model-deprecations
 */
export const SOL_MODEL = process.env.SOL_MODEL || 'claude-sonnet-5-5';
export const REVIEW_MODEL = process.env.REVIEW_MODEL || 'claude-sonnet-5-5';
export const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-5-5';
