import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { getBusinessMetrics } from '@/lib/business-metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Daily business snapshot
//
// Runs once a day and writes the headline KPIs into `analytics_metrics`
// (metric_type = 'business_snapshot'), one row per metric for the day. This
// gives the "Negocio" dashboard a durable history it can trend over time —
// independent of whether the source orders/analytics rows later change — and
// pins a daily probability-of-success score so drift is visible.
//
// Idempotent: re-running the same day upserts on (metric_type, metric_name,
// date_recorded) so a manual re-trigger never double-counts.
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const sb = createServiceClient();

  // A 30-day trailing snapshot is the headline the owner cares about day-to-day.
  const m = await getBusinessMetrics(30);
  const today = new Date().toISOString().slice(0, 10);

  const rows = [
    ['gross_sales_30d', m.revenue.gross_sales.current],
    ['net_revenue_30d', m.revenue.net_revenue.current],
    ['gross_profit_30d', m.revenue.gross_profit.current],
    ['net_profit_30d', m.revenue.net_profit.current],
    ['orders_30d', m.revenue.orders.current],
    ['avg_order_value_30d', m.revenue.avg_order_value.current],
    ['avg_margin_pct_30d', m.revenue.avg_margin_pct],
    ['ad_spend_30d', m.costs.ad_spend_total.current],
    ['roas_30d', m.costs.roas ?? 0],
    ['sessions_30d', m.traffic.sessions.current],
    ['wa_conversions_30d', m.agent.conversions.current],
    ['success_score', m.success.score],
  ].map(([metric_name, metric_value]) => ({
    metric_type: 'business_snapshot',
    metric_name: metric_name as string,
    metric_value: Number(metric_value) || 0,
    metric_data: { window_days: 30, label: m.success.label },
    date_recorded: today,
  }));

  const { error } = await sb
    .from('analytics_metrics')
    .upsert(rows, { onConflict: 'metric_type,metric_name,date_recorded' });

  if (error) {
    // If no unique constraint exists on those columns the upsert can't dedupe;
    // fall back to a delete-then-insert for today so the cron still succeeds.
    await sb
      .from('analytics_metrics')
      .delete()
      .eq('metric_type', 'business_snapshot')
      .eq('date_recorded', today);
    const { error: insErr } = await sb.from('analytics_metrics').insert(rows);
    if (insErr) {
      return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    date: today,
    metrics_written: rows.length,
    success_score: m.success.score,
    success_label: m.success.label,
    duration_ms: Date.now() - startedAt,
  });
}
