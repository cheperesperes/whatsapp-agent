import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase';
import {
  listPagePosts,
  listComments,
  replyToComment,
  pageId,
  type FbComment,
} from '@/lib/fb-comments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Facebook comment-responder.
//
// What & why: the sorteo posts collect lots of "Quiero" comments. Replying to
// each one (follow + register) nudges real entrants to complete their entry —
// but doing it by hand can't honour the hard rule "never reply to the same
// person twice" (the browser blocks reading the commenter list), and blasting
// 100+ replies would re-trip the spam enforcement that just suspended us.
//
// This cron does it safely through the Graph API:
//   • DEDUP BY PERSON — a ledger (fb_comment_replies) keyed by author_id. Once
//     we've replied to someone, they're skipped forever, across all posts/days.
//   • SELF-SEED — comments that already have a reply from our Page (or an
//     existing auto-responder) seed the ledger as 'already_answered', so we
//     never double up (this is what got Kenly doubled by hand).
//   • PACED — per-run cap (FB_COMMENT_RESPONDER_MAX, default 6); the cron runs
//     a few times a day, clearing the backlog over days, never in a burst.
//   • USA-only — comments mentioning Cuba are skipped (and logged), never
//     answered (the sorteo is US-only + we don't engage that angle).
//   • Compliant — varied reply copy, follow/comment/register only, NEVER
//     "tag a friend" (a Meta Promotions-Policy violation).
//
// Safety guards (real public outreach — guard it hard):
//   • DEFAULT OFF: FB_COMMENT_RESPONDER_ENABLED must be exactly 'true'.
//   • Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron adds this).
//   • Dry-run: `?dry=1` returns what it WOULD reply to, sends nothing.
//
// Go-live also needs META_PAGE_ACCESS_TOKEN to carry pages_read_engagement +
// pages_manage_engagement. See docs/COMMENT_RESPONDER.md.
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// USA-only: never reply to Cuba-intent comments.
const CUBA_RE =
  /\b(cuba|cubana?|habana|holgu[ií]n|santiago de cuba|matanzas|cienfuegos|camag[uü]ey|pinar del r[ií]o|guant[aá]namo|bayamo|las tunas|sancti sp[ií]ritus|isla de la juventud)\b/i;

// Varied, compliant replies — follow + register only, NO "tag a friend".
const REPLIES: readonly string[] = [
  '¡Gracias! 🙌 Para participar en el sorteo de la PECRON E2000LFP, sigue a Oiikon en Facebook e Instagram (@oiikon) y regístrate gratis 👉 oiikon.com/sorteo ⚡ ¡Mucha suerte! 🍀',
  '¡Qué bueno verte por aquí! 🎉 Participa gratis: sigue nuestra página de Facebook + Instagram (@oiikon) y regístrate en oiikon.com/sorteo ⚡',
  '¡Gracias por tu mensaje! 🌞 Para entrar al sorteo, sigue @oiikon en Facebook e Instagram y regístrate gratis en oiikon.com/sorteo 🎁',
  '¡Nos encanta tu energía! ⚡ Sigue a Oiikon en Facebook e Instagram (@oiikon) y regístrate gratis en oiikon.com/sorteo para participar 🍀',
  '¡Gracias! 🔋 Completa tu participación: sigue nuestra página oficial Oiikon en FB e IG (@oiikon) y regístrate en oiikon.com/sorteo 🎉',
  '¡Mucha suerte! 🍀 Para participar sigue a Oiikon en Facebook + Instagram (@oiikon) y regístrate gratis 👉 oiikon.com/sorteo ⚡',
];

function pickReply(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return REPLIES[h % REPLIES.length];
}

interface LedgerRow {
  comment_id: string;
  author_id: string | null;
}

interface RepliedItem {
  comment: string;
  author: string | null;
  reply?: string;
}
interface SkippedItem {
  comment: string;
  reason: string;
}
interface ErrorItem {
  comment?: string;
  post?: string;
  error: string;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled =
    (process.env.FB_COMMENT_RESPONDER_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'FB_COMMENT_RESPONDER_ENABLED!=true' },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const maxReplies = envNumber('FB_COMMENT_RESPONDER_MAX', 6);
  const postLimit = envNumber('FB_COMMENT_RESPONDER_POST_LIMIT', 12);
  const perPost = envNumber('FB_COMMENT_RESPONDER_COMMENTS_PER_POST', 50);

  const supabase = createServiceClient();
  const runId = randomUUID();
  const startedAt = Date.now();

  let me: string;
  try {
    me = pageId();
  } catch (e) {
    return NextResponse.json({ error: msg(e), run_id: runId }, { status: 500 });
  }

  // Load the dedup ledger: every comment + person we've already handled.
  const { data: ledgerRows } = await supabase
    .from('fb_comment_replies')
    .select('comment_id, author_id');
  const rows = (ledgerRows ?? []) as LedgerRow[];
  const seenComments = new Set<string>(rows.map((r) => r.comment_id));
  const seenAuthors = new Set<string>(
    rows.map((r) => r.author_id).filter((x): x is string => !!x),
  );

  const replied: RepliedItem[] = [];
  const skipped: SkippedItem[] = [];
  const errors: ErrorItem[] = [];
  let seededCount = 0;

  let posts;
  try {
    posts = await listPagePosts(postLimit);
  } catch (e) {
    return NextResponse.json(
      { error: `posts read failed: ${msg(e)}`, run_id: runId },
      { status: 502 },
    );
  }

  async function record(
    c: FbComment,
    postIdStr: string,
    status: string,
    replyText?: string,
  ): Promise<void> {
    if (dryRun) return;
    await supabase.from('fb_comment_replies').upsert(
      {
        comment_id: c.id,
        author_id: c.from?.id ?? null,
        author_name: c.from?.name ?? null,
        post_id: postIdStr,
        comment_excerpt: (c.message ?? '').slice(0, 160),
        reply_text: replyText ?? null,
        status,
      },
      { onConflict: 'comment_id' },
    );
  }

  for (const post of posts) {
    if (replied.length >= maxReplies) break;

    let comments: FbComment[];
    try {
      comments = await listComments(post.id, perPost);
    } catch (e) {
      errors.push({ post: post.id, error: msg(e) });
      continue;
    }

    for (const c of comments) {
      const authorId = c.from?.id ?? null;

      // SELF-SEED: already answered by our Page (manual or auto)? Mark the
      // person as done so we never double up — then move on.
      const answeredByUs = (c.comments?.data ?? []).some((r) => r.from?.id === me);
      if (answeredByUs) {
        if (authorId && !seenAuthors.has(authorId)) {
          seenAuthors.add(authorId);
          await record(c, post.id, 'already_answered');
          seededCount++;
        }
        seenComments.add(c.id);
        continue;
      }

      // Never reply to our own comments.
      if (authorId && authorId === me) continue;
      // Dedup: this exact comment, or this PERSON, already handled.
      if (seenComments.has(c.id)) continue;
      if (authorId && seenAuthors.has(authorId)) {
        skipped.push({ comment: c.id, reason: 'author_already_replied' });
        continue;
      }

      // USA-only: skip + log Cuba-intent comments, never answer them.
      if (CUBA_RE.test(c.message ?? '')) {
        await record(c, post.id, 'skipped_cuba');
        seenComments.add(c.id);
        if (authorId) seenAuthors.add(authorId);
        skipped.push({ comment: c.id, reason: 'cuba' });
        continue;
      }

      if (replied.length >= maxReplies) break;

      const reply = pickReply(c.id);
      if (dryRun) {
        replied.push({ comment: c.id, author: c.from?.name ?? authorId, reply });
        seenComments.add(c.id);
        if (authorId) seenAuthors.add(authorId);
        continue;
      }

      try {
        await replyToComment(c.id, reply);
        await record(c, post.id, 'replied', reply);
        seenComments.add(c.id);
        if (authorId) seenAuthors.add(authorId);
        replied.push({ comment: c.id, author: c.from?.name ?? authorId });
      } catch (e) {
        errors.push({ comment: c.id, error: msg(e) });
      }
    }
  }

  const summary = {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    duration_ms: Date.now() - startedAt,
    posts_scanned: posts.length,
    replied: replied.length,
    seeded: seededCount,
    skipped: skipped.length,
    errors: errors.length,
    max: maxReplies,
    details: dryRun || errors.length > 0 ? { replied, skipped, errors } : undefined,
  };

  console.log(
    `[comment-responder] run=${runId} replied=${replied.length} seeded=${seededCount} ` +
      `skipped=${skipped.length} errors=${errors.length} posts=${posts.length} dry=${dryRun}`,
  );

  return NextResponse.json(summary, { status: errors.length > 0 ? 207 : 200 });
}
