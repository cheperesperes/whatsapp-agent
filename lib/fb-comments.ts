/**
 * Facebook Page comment helpers (Graph API).
 *
 * Used by the comment-responder cron to read comments on the Oiikon Page's
 * posts and reply to them AS THE PAGE — via the official Graph API, not browser
 * automation. Reading via the API also returns each commenter's page-scoped id
 * (`from.id`), which is what lets us dedup by PERSON (one reply each, ever).
 *
 * Reuses the same creds the marketing publisher uses: META_PAGE_ID +
 * META_PAGE_ACCESS_TOKEN. Go-live needs that token to carry the
 * `pages_read_engagement` + `pages_manage_engagement` scopes — see
 * docs/COMMENT_RESPONDER.md.
 */

const META_API = 'https://graph.facebook.com/v21.0';

export interface FbActor {
  id: string;
  name?: string;
}

export interface FbReply {
  id: string;
  from?: FbActor;
}

export interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: FbActor;
  comments?: { data?: FbReply[] };
}

export interface FbPost {
  id: string;
  created_time?: string;
}

function creds(): { pageId: string; token: string } {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error('META_PAGE_ID or META_PAGE_ACCESS_TOKEN not set');
  }
  return { pageId, token };
}

/** The Page's own id — used to recognise (and skip) our own comments/replies. */
export function pageId(): string {
  return creds().pageId;
}

/** Recent posts on the Page (newest first). */
export async function listPagePosts(limit = 12): Promise<FbPost[]> {
  const { pageId: id, token } = creds();
  const url =
    `${META_API}/${id}/feed?fields=id,created_time&limit=${limit}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FB posts read failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { data?: FbPost[] };
  return data.data ?? [];
}

/**
 * Top-level comments on a post, each with up to 15 of its replies. We read the
 * nested replies so the responder can self-seed its dedup ledger: any comment
 * that already has a reply from our Page (or an auto-responder) marks that
 * commenter as "already answered" — so we never double up.
 */
export async function listComments(postId: string, limit = 50): Promise<FbComment[]> {
  const { token } = creds();
  const fields =
    'id,message,created_time,from{id,name},comments.limit(15){id,from{id,name}}';
  const url =
    `${META_API}/${postId}/comments?fields=${encodeURIComponent(fields)}` +
    `&filter=stream&order=chronological&limit=${limit}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FB comments read failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { data?: FbComment[] };
  return data.data ?? [];
}

/** Post a reply to a comment, as the Page. */
export async function replyToComment(
  commentId: string,
  message: string,
): Promise<{ id: string }> {
  const { token } = creds();
  const res = await fetch(`${META_API}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: token }),
  });
  if (!res.ok) {
    throw new Error(`FB reply failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}
