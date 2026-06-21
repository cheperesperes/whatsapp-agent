# Facebook comment-responder (cron)

Automated, **default-OFF** cron that replies to comments on the Oiikon Page's
posts **as the Page**, via the Graph API — built to clear the sorteo "Quiero"
backlog **safely** after the 2026-06 suspension.

Code: `app/api/cron/comment-responder/route.ts` · helpers: `lib/fb-comments.ts` ·
ledger table: `public.fb_comment_replies`.

## Why a cron (not by hand)
Replying to 100+ comments by hand can't satisfy the hard rule **"never reply to
the same person twice"** (the browser blocks reading the commenter list, so you
reply blind and double people up — it already happened to Kenly), and a 100-reply
burst would re-trip the spam enforcement that just suspended the account. The
Graph API solves both: it returns each commenter's id (dedup by **person**) and
we pace replies under the spam threshold.

## What it guarantees
- **Dedup by person** — `fb_comment_replies` is keyed by `author_id`. Once we've
  replied to someone, they're skipped forever, across all posts and days.
- **Self-seeding** — any comment that already has a reply from our Page (manual
  or an existing auto-responder) is recorded as `already_answered`, so we never
  double up on people who were already handled.
- **Paced** — `FB_COMMENT_RESPONDER_MAX` per run (default 6); the cron runs every
  4h, clearing the backlog over a few days, never in a burst.
- **USA-only** — comments mentioning Cuba are skipped + logged (`skipped_cuba`),
  never answered.
- **Compliant** — varied reply copy; follow + comment + register only; **never**
  "tag a friend" (a Meta Promotions-Policy violation).

## 1. Token scopes (the one human step)
The cron reuses `META_PAGE_ACCESS_TOKEN` (already set, used by the marketing
publisher). To read + post comments it must carry:

- `pages_read_engagement` — read comments + their authors
- `pages_manage_engagement` — post replies as the Page

If the current token lacks these, re-generate a Page token with them in Graph API
Explorer / the app's Login flow and update `META_PAGE_ACCESS_TOKEN` in Vercel.

## 2. Env vars (Vercel)
| Var | Default | Notes |
|---|---|---|
| `FB_COMMENT_RESPONDER_ENABLED` | `false` | **Must be `true` to reply.** Leave false until a dry-run looks right. |
| `FB_COMMENT_RESPONDER_MAX` | `6` | Replies per run. Keep low — pacing protects the account. |
| `FB_COMMENT_RESPONDER_POST_LIMIT` | `12` | How many recent posts to scan. |
| `FB_COMMENT_RESPONDER_COMMENTS_PER_POST` | `50` | Comments read per post. |
| `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `CRON_SECRET` | — | Already set (shared). |

## 3. Roll out safely
1. `git push` → Vercel (cron is scheduled `0 */4 * * *`; harmless while disabled — returns 503).
2. Confirm the token scopes (step 1).
3. **Dry-run:** `GET /api/cron/comment-responder?dry=1` with `Authorization: Bearer $CRON_SECRET`
   → returns the comments it WOULD reply to (sends nothing). Sanity-check: no
   Cuba comments, no one already answered, copy looks right.
4. Flip `FB_COMMENT_RESPONDER_ENABLED=true`. Watch the first couple of runs.

## Guards
Default-OFF · per-run cap · dedup by person + by comment · self-seed from existing
replies · Cuba skip · `?dry=1` · `CRON_SECRET` auth.

## Notes
- **First run self-seeds, doesn't blast:** existing/auto replies mark those people
  `already_answered` first; only genuinely-unanswered, non-Cuba commenters get a
  reply, capped at `FB_COMMENT_RESPONDER_MAX`.
- If `from.id` ever comes back empty (Meta privacy), dedup falls back to
  `comment_id` (still never replies to the same comment twice).
