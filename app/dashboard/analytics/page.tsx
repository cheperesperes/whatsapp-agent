'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase';

interface Stats {
  total: number;
  active: number;
  escalated: number;
  closed: number;
  messagesTotal: number;
  messagesLastWeek: number;
  escalationRate: number;
  topProducts: { product_interest: string; count: number }[];
  conversationsByDay: { date: string; count: number }[];
  recentHandoffs: {
    id: string;
    reason: string;
    last_customer_message: string | null;
    created_at: string;
    resolved: boolean;
    phone_number?: string;
  }[];
}

function StatCard({
  label,
  value,
  sub,
  color = 'default',
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: 'default' | 'green' | 'red' | 'yellow' | 'brand';
}) {
  const colorMap = {
    default: 'text-white',
    green: 'text-green-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    brand: 'text-brand-400',
  };
  return (
    <div className="card p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${colorMap[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createBrowserClient();

  useEffect(() => {
    async function load() {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);

      const [
        { count: total },
        { count: active },
        { count: escalated },
        { count: closed },
        { count: messagesTotal },
        { count: messagesLastWeek },
        { data: convs },
        { data: handoffs },
      ] = await Promise.all([
        supabase.from('conversations').select('*', { count: 'exact', head: true }),
        supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'escalated'),
        supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
        supabase.from('messages').select('*', { count: 'exact', head: true }),
        supabase.from('messages').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()),
        supabase.from('conversations').select('product_interest, created_at').order('created_at', { ascending: false }).limit(500),
        supabase
          .from('handoffs')
          .select('id, reason, last_customer_message, created_at, resolved, conversation_id')
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      // Top products
      const productCounts: Record<string, number> = {};
      (convs ?? []).forEach((c) => {
        if (c.product_interest) {
          productCounts[c.product_interest] = (productCounts[c.product_interest] ?? 0) + 1;
        }
      });
      const topProducts = Object.entries(productCounts)
        .map(([product_interest, count]) => ({ product_interest, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // Conversations by day (last 7 days)
      const dayMap: Record<string, number> = {};
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now.getTime() - i * 86400000);
        return d.toISOString().split('T')[0];
      }).reverse();

      days.forEach((d) => { dayMap[d] = 0; });
      (convs ?? []).forEach((c) => {
        const day = c.created_at?.split('T')[0];
        if (day && dayMap[day] !== undefined) dayMap[day]++;
      });

      const conversationsByDay = days.map((date) => ({ date, count: dayMap[date] }));

      // Get phone numbers for recent handoffs
      const handoffList = await Promise.all(
        (handoffs ?? []).map(async (h) => {
          const { data: conv } = await supabase
            .from('conversations')
            .select('phone_number')
            .eq('id', h.conversation_id)
            .single();
          return { ...h, phone_number: conv?.phone_number };
        })
      );

      const escalationRate = (total ?? 0) > 0
        ? Math.round(((escalated ?? 0) / (total ?? 1)) * 100)
        : 0;

      setStats({
        total: total ?? 0,
        active: active ?? 0,
        escalated: escalated ?? 0,
        closed: closed ?? 0,
        messagesTotal: messagesTotal ?? 0,
        messagesLastWeek: messagesLastWeek ?? 0,
        escalationRate,
        topProducts,
        conversationsByDay,
        recentHandoffs: handoffList,
      });
      setLoading(false);
    }

    load();
  }, [supabase]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-600 bg-surface-800 shrink-0">
        <h2 className="text-base font-semibold text-white">Analíticas</h2>
        <p className="text-xs text-gray-500 mt-0.5">Rendimiento del agente Sol</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
          Cargando datos...
        </div>
      ) : stats ? (
        <div className="p-6 space-y-6">
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCard label="Total Conversaciones" value={stats.total} color="brand" />
            <StatCard label="Activas" value={stats.active} color="green" />
            <StatCard label="Escaladas" value={stats.escalated} color="red"
              sub={`${stats.escalationRate}% tasa de escalamiento`} />
            <StatCard label="Cerradas" value={stats.closed} />
            <StatCard label="Mensajes (7 días)" value={stats.messagesLastWeek}
              sub={`${stats.messagesTotal} total`} color="yellow" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Conversations by day */}
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">
                Nuevas conversaciones (últimos 7 días)
              </h3>
              <div className="flex items-end gap-2 h-32">
                {stats.conversationsByDay.map(({ date, count }) => {
                  const max = Math.max(...stats.conversationsByDay.map((d) => d.count), 1);
                  const height = Math.max((count / max) * 100, count > 0 ? 10 : 4);
                  return (
                    <div key={date} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-xs text-gray-400">{count || ''}</span>
                      <div
                        className="w-full rounded-t bg-brand-600/70 hover:bg-brand-500 transition-colors"
                        style={{ height: `${height}%`, minHeight: '4px' }}
                        title={`${date}: ${count} conversaciones`}
                      />
                      <span className="text-xs text-gray-600 truncate w-full text-center">
                        {new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short' })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top products of interest */}
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">
                Productos más consultados
              </h3>
              {stats.topProducts.length === 0 ? (
                <p className="text-gray-600 text-sm">Sin datos aún</p>
              ) : (
                <div className="space-y-2">
                  {stats.topProducts.map(({ product_interest, count }) => {
                    const max = stats.topProducts[0]?.count ?? 1;
                    const pct = Math.round((count / max) * 100);
                    return (
                      <div key={product_interest}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-300 truncate">{product_interest}</span>
                          <span className="text-xs text-gray-500 ml-2">{count}</span>
                        </div>
                        <div className="h-1.5 bg-surface-600 rounded-full">
                          <div
                            className="h-full bg-brand-500 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Recent Handoffs */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-600">
              <h3 className="text-sm font-semibold text-gray-300">Handoffs recientes</h3>
            </div>
            {stats.recentHandoffs.length === 0 ? (
              <p className="text-gray-600 text-sm p-4">Sin handoffs registrados</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-700">
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Cliente</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Razón</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2 max-w-xs">Último mensaje</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Fecha</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentHandoffs.map((h) => (
                    <tr key={h.id} className="border-b border-surface-700 hover:bg-surface-800/50">
                      <td className="px-4 py-2.5 text-xs font-mono text-gray-300">
                        {h.phone_number ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-300">{h.reason}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate">
                        {h.last_customer_message ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">
                        {new Date(h.created_at).toLocaleString('es-ES', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-2.5">
                        {h.resolved ? (
                          <span className="badge-active">Resuelto</span>
                        ) : (
                          <span className="badge-escalated">Pendiente</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
