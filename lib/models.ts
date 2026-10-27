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
