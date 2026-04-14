import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Auth is enforced by middleware.ts (this path is not in PUBLIC_PATHS).
// Once past middleware we can safely use the service-role client to
// aggregate stats bypassing RLS.
export async function GET() {
  const supabase = createServiceClient();

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    { data: allConvs },
    { data: allMsgs },
    { data: handoffsRaw },
  ] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, status, product_interest, created_at, phone_number, escalated')
      .order('created_at', { ascending: false })
      .limit(2000),
    supabase
      .from('messages')
      .select('id, created_at')
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('handoffs')
      .select('id, reason, last_customer_message, created_at, resolved, conversation_id')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const convs = allConvs ?? [];
  const msgs = allMsgs ?? [];
  const handoffs = handoffsRaw ?? [];

  const total = convs.length;
  const active = convs.filter((c) => c.status === 'active').length;
  const escalated = convs.filter((c) => c.status === 'escalated').length;
  const closed = convs.filter((c) => c.status === 'closed').length;
  const messagesTotal = msgs.length;
  const messagesLastWeek = msgs.filter((m) => m.created_at >= weekAgo.toISOString()).length;

  const productCounts: Record<string, number> = {};
  convs.forEach((c) => {
    if (c.product_interest) {
      productCounts[c.product_interest] = (productCounts[c.product_interest] ?? 0) + 1;
    }
  });
  const topProducts = Object.entries(productCounts)
    .map(([product_interest, count]) => ({ product_interest, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const dayMap: Record<string, number> = {};
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getTime() - i * 86400000);
    return d.toISOString().split('T')[0];
  }).reverse();
  days.forEach((d) => { dayMap[d] = 0; });
  convs.forEach((c) => {
    const day = c.created_at?.split('T')[0];
    if (day && dayMap[day] !== undefined) dayMap[day]++;
  });
  const conversationsByDay = days.map((date) => ({ date, count: dayMap[date] }));

  const phoneById: Record<string, string> = {};
  convs.forEach((c) => {
    if (c.id && c.phone_number) phoneById[c.id] = c.phone_number;
  });
  const recentHandoffs = handoffs.map((h) => ({
    id: h.id,
    reason: h.reason,
    last_customer_message: h.last_customer_message,
    created_at: h.created_at,
    resolved: h.resolved,
    phone_number: phoneById[h.conversation_id],
  }));

  const escalationRate = total > 0 ? Math.round((escalated / total) * 100) : 0;

  return NextResponse.json({
    total,
    active,
    escalated,
    closed,
    messagesTotal,
    messagesLastWeek,
    escalationRate,
    topProducts,
    conversationsByDay,
    recentHandoffs,
  });
}
