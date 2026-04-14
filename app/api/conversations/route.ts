import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import type { Conversation, Message } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = (convs ?? []) as Conversation[];
  if (list.length === 0) {
    return NextResponse.json({ conversations: [] });
  }

  // One query per conversation would be an N+1. Pull the most-recent message
  // per conversation in a single query using DISTINCT ON-like pattern via a
  // bulk fetch + client-side grouping.
  const ids = list.map((c) => c.id);
  const { data: msgs } = await supabase
    .from('messages')
    .select('*')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false });

  const lastByConv: Record<string, Message> = {};
  for (const m of (msgs ?? []) as Message[]) {
    if (!lastByConv[m.conversation_id]) {
      lastByConv[m.conversation_id] = m;
    }
  }

  const withLast = list.map((c) => ({ ...c, last_message: lastByConv[c.id] }));
  return NextResponse.json({ conversations: withLast });
}
