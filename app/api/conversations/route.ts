import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import type { Conversation, Message } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// Common no-store headers — prevent Vercel edge / browser / proxy caching.
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

// GET /api/conversations
// Returns all conversations ordered by updated_at desc, each with its last message.
// Auth enforced by middleware.
export async function GET() {
  const supabase = createServiceClient();

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS });
  }

  const list = (convs ?? []) as Conversation[];
  if (list.length === 0) {
    return NextResponse.json({ conversations: [] }, { headers: NO_CACHE_HEADERS });
  }

  // One query per conversation would be an N+1. Pull the most-recent message
  // per conversation in a single query using DISTINCT ON-like pattern via a
  // bulk fetch + client-side grouping.
  // Page through messages newest-first. A single query is capped by Supabase's
  // 1,000-row default, so with ~5,400 messages the older chats came back with
  // no last message and showed "Sin mensajes" (392 of 531 on 2026-10-23).
  // Stops as soon as every conversation has its latest message.
  const lastByConv: Record<string, Message> = {};
  const PAGE = 1000;
  const MAX_PAGES = 50; // runaway guard (~50k messages)
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: msgs, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (msgErr || !msgs || msgs.length === 0) break;
    for (const m of msgs as Message[]) {
      if (!lastByConv[m.conversation_id]) lastByConv[m.conversation_id] = m;
    }
    if (msgs.length < PAGE || Object.keys(lastByConv).length >= list.length) break;
  }

  const withLast = list.map((c) => ({ ...c, last_message: lastByConv[c.id] }));
  return NextResponse.json({ conversations: withLast }, { headers: NO_CACHE_HEADERS });
}
