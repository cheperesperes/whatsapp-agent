// ============================================================
// Business-health metrics for the Oiikon e-commerce dashboard
// ------------------------------------------------------------
// One place that stitches together the numbers a business owner
// actually asks about — "are we growing or losing money, and how
// likely is this to work?" — from the tables that already exist:
//
//   • orders + order_financials → revenue, gross/net profit, margin
//   • ad_spend                  → Facebook / Google / WhatsApp ad cost
//   • expenses / refunds        → operating cost + money given back
//   • analytics_metrics         → website visitors, sessions, events
//   • conversations / messages  → the WhatsApp "Sol" agent funnel
//
// Everything is computed for a trailing window AND the equal window
// immediately before it, so every headline can show a growth/loss
// delta. The probability-of-success score at the bottom is a
// transparent weighted blend of those signals — no magic, every
// sub-score is returned so the UI can explain itself.
// ============================================================

import { createServiceClient } from './supabase';
import { getOverviewMetrics } from './supabase';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────

/** A current-vs-previous pair plus the % change between them. */
export interface Delta {
  current: number;
  previous: number;
  /** Percent change, rounded to 1 decimal. null when previous is 0 (can't divide). */
  change_pct: number | null;
}

export interface RevenueBlock {
  gross_sales: Delta;      // sum of orders.total (paid)
  net_revenue: Delta;      // order_financials.total_revenue (paid)
  gross_profit: Delta;     // order_financials.gross_profit
  net_profit: Delta;       // order_financials.net_profit_with_expenses
  orders: Delta;           // count of paid orders
  avg_order_value: Delta;  // gross_sales / orders
  avg_margin_pct: number;  // avg order_financials.margin_percentage (current window)
  refunds: number;         // refunds returned in the current window
}

export interface CostBlock {
  ad_spend_total: Delta;                          // all channels, from ad_spend table
  by_channel: { channel: string; spend: number }[]; // current window, per channel
  expenses: Delta;                                // operating expenses
  roas: number | null;                            // net_revenue / ad_spend (current)
}

export interface TrafficBlock {
  sessions: Delta;   // analytics_metrics unique sessions
  events: Delta;     // analytics_metrics total events (clicks, scrolls…)
  /** Rough site conversion: paid orders / sessions, current window, %. */
  conversion_pct: number | null;
}

export interface AgentBlock {
  conversations: Delta;
  conversions: Delta;       // operator-confirmed WhatsApp sales
  deep_conversations: number;
  escalated: number;
  messages_customer: number;
  messages_sol: number;
}

export interface SuccessScore {
  /** 0–100 overall. */
  score: number;
  /** 'saludable' | 'estable' | 'en_riesgo' | 'critico' */
  label: string;
  /** Each driver, already 0–100, with the weight applied. null = no data. */
  drivers: {
    key: string;
    label: string;
    value: number | null;   // sub-score 0–100 (null when we lack data)
    weight: number;          // fraction of the total
    detail: string;          // human explanation of what fed it
  }[];
}

export interface DailyPoint {
  date: string;      // YYYY-MM-DD
  revenue: number;   // paid gross sales that day
  orders: number;
  sessions: number;
}

/** Facebook / Instagram / YouTube engagement, summed over the window. */
export interface SocialBlock {
  facebook: { likes: number; comments: number; shares: number; reach: number };
  instagram: { likes: number; comments: number };
  youtube: { views: number; likes: number };
  has_data: boolean;
}

/** One recurring background job that feeds the business. */
export interface AutomationRow {
  key: string;
  label: string;
  last_run: string | null;  // ISO of the most recent activity
  window_count: number;     // how many times it ran in the current window
  healthy: boolean;         // ran within the last ~48h
}

export interface AutomationBlock {
  emails_sent: Delta;
  rows: AutomationRow[];
}

/** A data-driven recommendation surfaced to the operator. */
export interface Insight {
  level: 'good' | 'warn' | 'risk';
  title: string;
  detail: string;
}

export interface BusinessMetrics {
  window_days: number;
  generated_at: string;
  revenue: RevenueBlock;
  costs: CostBlock;
  traffic: TrafficBlock;
  agent: AgentBlock;
  social: SocialBlock;
  automation: AutomationBlock;
  lifetime: { paid_orders: number; gross_sales: number };
  daily: DailyPoint[];
  success: SuccessScore;
  insights: Insight[];
}

// ── Small helpers ───────────────────────────────────────────

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function delta(current: number, previous: number, dp = 2): Delta {
  const c = round(current, dp);
  const p = round(previous, dp);
  return {
    current: c,
    previous: p,
    change_pct: p === 0 ? null : round(((c - p) / Math.abs(p)) * 100, 1),
  };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Row shapes we read ──────────────────────────────────────

interface OrderRow {
  id: string;
  total: number | string | null;
  paid_at: string | null;
  created_at: string;
}

interface FinRow {
  order_id: string;
  total_revenue: number | string | null;
  gross_profit: number | string | null;
  net_profit_with_expenses: number | string | null;
  margin_percentage: number | string | null;
}

// ============================================================
// Main entry point
// ============================================================

export async function getBusinessMetrics(windowDays = 30): Promise<BusinessMetrics> {
  const days = Math.max(1, Math.min(windowDays, 365));
  const sb = createServiceClient();

  const now = Date.now();
  const curStart = new Date(now - days * DAY_MS);          // start of current window
  const prevStart = new Date(now - 2 * days * DAY_MS);     // start of previous window
  const curStartISO = curStart.toISOString();
  const prevStartISO = prevStart.toISOString();

  const [
    paidOrders,
    adSpendRows,
    expenseRows,
    refundRows,
    sessionRows,
    eventRows,
    agentCur,
    agentPrev,
    lifetime,
    emailRows,
    socialRows,
    contentRows,
  ] = await Promise.all([
    // Paid orders across BOTH windows (bucketed later by paid_at).
    sb
      .from('orders')
      .select('id, total, paid_at, created_at')
      .eq('payment_status', 'paid')
      .gte('paid_at', prevStartISO),
    // Manual/weekly ad spend log (Facebook / Google / WhatsApp).
    sb
      .from('ad_spend')
      .select('week_start, channel, spend')
      .gte('week_start', ymd(prevStart)),
    sb
      .from('expenses')
      .select('amount, transaction_date')
      .gte('transaction_date', prevStartISO),
    sb
      .from('refunds')
      .select('refund_amount, created_at')
      .gte('created_at', prevStartISO),
    // Website visitors: one row per day.
    sb
      .from('analytics_metrics')
      .select('metric_value, date_recorded')
      .eq('metric_type', 'unique_sessions')
      .eq('metric_name', 'distinct_user_sessions')
      .gte('date_recorded', ymd(prevStart)),
    sb
      .from('analytics_metrics')
      .select('metric_value, date_recorded')
      .eq('metric_type', 'events_total')
      .eq('metric_name', 'all')
      .gte('date_recorded', ymd(prevStart)),
    getOverviewMetrics(days),
    getOverviewMetrics(days * 2), // 2× window; we subtract to get the prior window
    // Lifetime paid orders (small table — cheap).
    sb
      .from('orders')
      .select('total', { count: 'exact' })
      .eq('payment_status', 'paid'),
    // Daily automation: transactional/marketing emails sent.
    sb
      .from('email_logs')
      .select('created_at')
      .gte('created_at', prevStartISO),
    // Facebook / social engagement — daily rows written by the social-stats cron.
    sb
      .from('analytics_metrics')
      .select('metric_name, metric_value, date_recorded')
      .eq('metric_type', 'social_engagement')
      .gte('date_recorded', ymd(curStart)),
    // Marketing content produced by the daily marketing routine.
    sb
      .from('marketing_content')
      .select('created_at')
      .gte('created_at', prevStartISO),
  ]);

  // ---- Revenue & profit (join financials to paid orders in JS) ----
  const orders = (paidOrders.data ?? []) as OrderRow[];
  const ids = orders.map((o) => o.id);

  const finByOrder = new Map<string, FinRow>();
  if (ids.length > 0) {
    const { data: finData } = await sb
      .from('order_financials')
      .select('order_id, total_revenue, gross_profit, net_profit_with_expenses, margin_percentage')
      .in('order_id', ids);
    for (const f of (finData ?? []) as FinRow[]) finByOrder.set(f.order_id, f);
  }

  const inCurrent = (iso: string | null) => iso != null && iso >= curStartISO;

  // Accumulators for current (c) and previous (p) windows.
  const acc = {
    cGross: 0, pGross: 0,
    cNetRev: 0, pNetRev: 0,
    cGP: 0, pGP: 0,
    cNP: 0, pNP: 0,
    cOrders: 0, pOrders: 0,
    marginSum: 0, marginN: 0,
  };
  // Per-day revenue/orders for the current window.
  const dailyRevenue = new Map<string, { revenue: number; orders: number }>();

  for (const o of orders) {
    const when = o.paid_at ?? o.created_at;
    const isCur = inCurrent(o.paid_at);
    const total = num(o.total);
    const fin = finByOrder.get(o.id);
    const netRev = fin ? num(fin.total_revenue) : total;
    const gp = fin ? num(fin.gross_profit) : 0;
    const np = fin ? num(fin.net_profit_with_expenses) : 0;

    if (isCur) {
      acc.cGross += total; acc.cNetRev += netRev; acc.cGP += gp; acc.cNP += np; acc.cOrders += 1;
      if (fin && fin.margin_percentage != null) { acc.marginSum += num(fin.margin_percentage); acc.marginN += 1; }
      const key = (when ?? curStartISO).slice(0, 10);
      const d = dailyRevenue.get(key) ?? { revenue: 0, orders: 0 };
      d.revenue += total; d.orders += 1;
      dailyRevenue.set(key, d);
    } else {
      acc.pGross += total; acc.pNetRev += netRev; acc.pGP += gp; acc.pNP += np; acc.pOrders += 1;
    }
  }

  // ---- Ad spend (per channel, current window) ----
  const spendRows = (adSpendRows.data ?? []) as { week_start: string; channel: string | null; spend: number | string | null }[];
  const curSpendStr = ymd(curStart);
  let cSpend = 0, pSpend = 0;
  const channelSpend = new Map<string, number>();
  for (const r of spendRows) {
    const s = num(r.spend);
    if (r.week_start >= curSpendStr) {
      cSpend += s;
      const ch = (r.channel ?? 'otro').toLowerCase();
      channelSpend.set(ch, (channelSpend.get(ch) ?? 0) + s);
    } else {
      pSpend += s;
    }
  }

  // ---- Expenses & refunds ----
  const expRows = (expenseRows.data ?? []) as { amount: number | string | null; transaction_date: string }[];
  let cExp = 0, pExp = 0;
  for (const r of expRows) {
    (r.transaction_date >= curStartISO ? (cExp += num(r.amount)) : (pExp += num(r.amount)));
  }
  const refRows = (refundRows.data ?? []) as { refund_amount: number | string | null; created_at: string }[];
  let cRefunds = 0;
  for (const r of refRows) if (r.created_at >= curStartISO) cRefunds += num(r.refund_amount);

  // ---- Traffic ----
  const sRows = (sessionRows.data ?? []) as { metric_value: number | string | null; date_recorded: string }[];
  const eRows = (eventRows.data ?? []) as { metric_value: number | string | null; date_recorded: string }[];
  let cSessions = 0, pSessions = 0;
  const dailySessions = new Map<string, number>();
  for (const r of sRows) {
    const v = num(r.metric_value);
    if (r.date_recorded >= curSpendStr) { cSessions += v; dailySessions.set(r.date_recorded, v); }
    else pSessions += v;
  }
  let cEvents = 0, pEvents = 0;
  for (const r of eRows) (r.date_recorded >= curSpendStr ? (cEvents += num(r.metric_value)) : (pEvents += num(r.metric_value)));

  // ---- Agent (subtract 2× window from 1× to get the prior window) ----
  const agentPrevWindow = {
    conversations_new: Math.max(0, agentPrev.conversations_new - agentCur.conversations_new),
    conversions: Math.max(0, agentPrev.conversions - agentCur.conversions),
  };

  // ---- Assemble blocks ----
  const revenue: RevenueBlock = {
    gross_sales: delta(acc.cGross, acc.pGross),
    net_revenue: delta(acc.cNetRev, acc.pNetRev),
    gross_profit: delta(acc.cGP, acc.pGP),
    net_profit: delta(acc.cNP, acc.pNP),
    orders: delta(acc.cOrders, acc.pOrders, 0),
    avg_order_value: delta(
      acc.cOrders ? acc.cGross / acc.cOrders : 0,
      acc.pOrders ? acc.pGross / acc.pOrders : 0,
    ),
    avg_margin_pct: acc.marginN ? round(acc.marginSum / acc.marginN, 1) : 0,
    refunds: round(cRefunds),
  };

  const costs: CostBlock = {
    ad_spend_total: delta(cSpend, pSpend),
    by_channel: [...channelSpend.entries()]
      .map(([channel, spend]) => ({ channel, spend: round(spend) }))
      .sort((a, b) => b.spend - a.spend),
    expenses: delta(cExp, pExp),
    roas: cSpend > 0 ? round(acc.cNetRev / cSpend, 2) : null,
  };

  const traffic: TrafficBlock = {
    sessions: delta(cSessions, pSessions, 0),
    events: delta(cEvents, pEvents, 0),
    conversion_pct: cSessions > 0 ? round((acc.cOrders / cSessions) * 100, 2) : null,
  };

  const agent: AgentBlock = {
    conversations: delta(agentCur.conversations_new, agentPrevWindow.conversations_new, 0),
    conversions: delta(agentCur.conversions, agentPrevWindow.conversions, 0),
    deep_conversations: agentCur.deep_conversations,
    escalated: agentCur.escalated,
    messages_customer: agentCur.messages_customer,
    messages_sol: agentCur.messages_sol,
  };

  // ---- Daily series (union of revenue days + session days), current window only ----
  const dayKeys = new Set<string>([...dailyRevenue.keys(), ...dailySessions.keys()]);
  const daily: DailyPoint[] = [...dayKeys]
    .filter((k) => k >= curSpendStr)
    .sort()
    .map((date) => ({
      date,
      revenue: round(dailyRevenue.get(date)?.revenue ?? 0),
      orders: dailyRevenue.get(date)?.orders ?? 0,
      sessions: dailySessions.get(date) ?? 0,
    }));

  const lifetimeSales = ((lifetime.data ?? []) as { total: number | string | null }[])
    .reduce((s, r) => s + num(r.total), 0);

  // ---- Social engagement (analytics_metrics social_engagement, current window) ----
  const socData = (socialRows.data ?? []) as { metric_name: string; metric_value: number | string | null }[];
  const sumSoc = (name: string) =>
    socData.filter((r) => r.metric_name === name).reduce((s, r) => s + num(r.metric_value), 0);
  const social: SocialBlock = {
    facebook: {
      likes: sumSoc('facebook_likes'),
      comments: sumSoc('facebook_comments'),
      shares: sumSoc('facebook_shares'),
      reach: sumSoc('facebook_reach'),
    },
    instagram: { likes: sumSoc('instagram_likes'), comments: sumSoc('instagram_comments') },
    youtube: { views: sumSoc('youtube_views'), likes: sumSoc('youtube_likes') },
    has_data: socData.length > 0,
  };

  // ---- Daily automations (freshness + throughput) ----
  const emailData = (emailRows.data ?? []) as { created_at: string }[];
  const contentData = (contentRows.data ?? []) as { created_at: string }[];
  const cutoff48h = new Date(now - 2 * DAY_MS).toISOString();

  const buildAutomation = (
    key: string,
    label: string,
    rows: { created_at?: string; date_recorded?: string }[],
  ): AutomationRow => {
    const stamps = rows
      .map((r) => r.created_at ?? (r.date_recorded ? `${r.date_recorded}T00:00:00Z` : null))
      .filter((s): s is string => Boolean(s));
    const inWindow = stamps.filter((s) => s >= curStartISO).length;
    const last = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
    return { key, label, last_run: last, window_count: inWindow, healthy: last != null && last >= cutoff48h };
  };

  const emailsCur = emailData.filter((r) => r.created_at >= curStartISO).length;
  const emailsPrev = emailData.length - emailsCur;
  const automation: AutomationBlock = {
    emails_sent: delta(emailsCur, emailsPrev, 0),
    rows: [
      buildAutomation('email', 'Correos (resumen diario, pedidos, reseñas)', emailData),
      buildAutomation('analytics', 'Instantánea de analítica web', sRows.map((r) => ({ date_recorded: r.date_recorded }))),
      buildAutomation('marketing', 'Contenido de marketing generado', contentData),
    ],
  };

  const success = computeSuccessScore({ revenue, costs, traffic, agent });
  const insights = buildInsights({ revenue, costs, traffic, agent, automation, windowDays: days });

  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    revenue,
    costs,
    traffic,
    agent,
    social,
    automation,
    lifetime: { paid_orders: lifetime.count ?? orders.length, gross_sales: round(lifetimeSales) },
    daily,
    success,
    insights,
  };
}

// ============================================================
// Data-driven suggestions
// ------------------------------------------------------------
// Plain rules over the numbers we just computed. Each one is a
// concrete "here's what the data says, here's what to do" nudge.
// Ordered risk → warn → good so the most urgent surfaces first.
// ============================================================

function buildInsights(m: {
  revenue: RevenueBlock;
  costs: CostBlock;
  traffic: TrafficBlock;
  agent: AgentBlock;
  automation: AutomationBlock;
  windowDays: number;
}): Insight[] {
  const out: Insight[] = [];
  const w = m.windowDays;

  // Revenue trend.
  const salesChange = m.revenue.gross_sales.change_pct;
  if (salesChange != null && salesChange <= -15) {
    out.push({
      level: 'risk',
      title: `Ventas cayeron ${salesChange}% vs los ${w} días anteriores`,
      detail: `Pasaste de $${m.revenue.gross_sales.previous.toLocaleString()} a $${m.revenue.gross_sales.current.toLocaleString()}. Revisa stock de los productos estrella y reactiva anuncios de los que más convierten.`,
    });
  } else if (salesChange != null && salesChange >= 15) {
    out.push({
      level: 'good',
      title: `Ventas subieron ${salesChange}% vs el período anterior`,
      detail: `Buen momento para reinvertir en los canales que están trayendo compradores y asegurar inventario.`,
    });
  }

  // Margin / profitability.
  if (m.revenue.orders.current > 0 && m.revenue.avg_margin_pct < 20) {
    out.push({
      level: 'warn',
      title: `Margen promedio bajo (${m.revenue.avg_margin_pct}%)`,
      detail: `El margen está por debajo del 20%. Revisa costos de envío/agencia y descuentos aplicados — un cupón demasiado agresivo puede estar comiéndose la ganancia.`,
    });
  }

  // Ad spend / ROAS attribution.
  if (m.costs.ad_spend_total.current === 0) {
    out.push({
      level: 'warn',
      title: 'No hay gasto de anuncios registrado',
      detail: 'Conecta Facebook, Google y WhatsApp Ads (o registra el gasto semanal) para poder medir el ROAS. Sin gasto no se puede saber qué anuncio realmente deja dinero.',
    });
  } else if (m.costs.roas != null && m.costs.roas < 1.5) {
    out.push({
      level: 'risk',
      title: `ROAS bajo (${m.costs.roas}×)`,
      detail: 'Por cada $1 en anuncios recuperas menos de $1.50 en ingreso. Pausa las campañas de peor rendimiento y concentra el presupuesto en las de mejor conversión.',
    });
  }

  // Site conversion.
  if (m.traffic.conversion_pct != null && m.traffic.sessions.current > 50 && m.traffic.conversion_pct < 1) {
    out.push({
      level: 'warn',
      title: `Conversión web baja (${m.traffic.conversion_pct}%)`,
      detail: `Llegan visitas (${m.traffic.sessions.current} sesiones) pero pocas terminan en compra. Revisa precios visibles, tiempos de carga y que el checkout no tenga fricción.`,
    });
  }

  // Automation health — the daily jobs that keep the business moving.
  const stale = m.automation.rows.filter((r) => !r.healthy);
  if (stale.length > 0) {
    out.push({
      level: 'warn',
      title: `${stale.length} automatización(es) sin actividad reciente`,
      detail: `Sin correr en las últimas 48h: ${stale.map((r) => r.label).join(', ')}. Verifica los crons en Vercel.`,
    });
  }

  // WhatsApp agent escalations.
  if (m.agent.escalated > 0 && m.agent.conversations.current > 0) {
    const rate = round((m.agent.escalated / m.agent.conversations.current) * 100, 0);
    if (rate >= 25) {
      out.push({
        level: 'warn',
        title: `${rate}% de conversaciones se escalaron a un humano`,
        detail: 'Muchas escalaciones sugieren huecos en la base de conocimiento de Sol. Revisa la pestaña Sugerencias para cerrar las preguntas que Sol no supo responder.',
      });
    }
  }

  if (out.length === 0) {
    out.push({
      level: 'good',
      title: 'Sin alertas — el negocio se ve estable',
      detail: 'Los indicadores clave están dentro de rangos saludables para este período.',
    });
  }

  // risk first, then warn, then good.
  const order = { risk: 0, warn: 1, good: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ============================================================
// Probability-of-success score
// ------------------------------------------------------------
// A transparent 0–100 blend. Each driver is normalized to 0–100
// and weighted. Drivers with no data (value=null) are dropped and
// the remaining weights are renormalized, so a missing ad-spend
// feed doesn't silently tank the score.
// ============================================================

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Map a % growth figure to 0–100: 0% → 50, +50% → 100, −50% → 0. */
function growthToScore(pct: number | null): number | null {
  if (pct == null) return null;
  return clamp(50 + pct, 0, 100);
}

function computeSuccessScore(m: {
  revenue: RevenueBlock;
  costs: CostBlock;
  traffic: TrafficBlock;
  agent: AgentBlock;
}): SuccessScore {
  const drivers: SuccessScore['drivers'] = [];

  // 1) Profitability — is the business actually making money? (margin %)
  const margin = m.revenue.avg_margin_pct;
  const profitScore = m.revenue.orders.current > 0
    ? clamp((margin / 40) * 100) // 40%+ margin = full marks
    : null;
  drivers.push({
    key: 'profitability',
    label: 'Rentabilidad',
    value: profitScore == null ? null : round(profitScore, 0),
    weight: 0.3,
    detail: profitScore == null ? 'Sin ventas en el período' : `Margen promedio ${margin}%`,
  });

  // 2) Revenue growth vs the previous window.
  const growthScore = growthToScore(m.revenue.net_profit.change_pct ?? m.revenue.gross_sales.change_pct);
  drivers.push({
    key: 'growth',
    label: 'Crecimiento',
    value: growthScore == null ? null : round(growthScore, 0),
    weight: 0.3,
    detail:
      m.revenue.gross_sales.change_pct == null
        ? 'Sin base de comparación'
        : `Ventas ${m.revenue.gross_sales.change_pct >= 0 ? '+' : ''}${m.revenue.gross_sales.change_pct}% vs período anterior`,
  });

  // 3) Marketing efficiency — ROAS (net revenue per $1 of ad spend).
  const roas = m.costs.roas;
  const roasScore = roas == null ? null : clamp((roas / 4) * 100); // 4× ROAS = full marks
  drivers.push({
    key: 'roas',
    label: 'Eficiencia de anuncios',
    value: roasScore == null ? null : round(roasScore, 0),
    weight: 0.2,
    detail: roas == null ? 'Sin datos de gasto en anuncios' : `ROAS ${roas}× (ingreso ÷ gasto)`,
  });

  // 4) Demand & conversion — sessions growth + agent conversions.
  const demandParts: number[] = [];
  const sessGrowth = growthToScore(m.traffic.sessions.change_pct);
  if (sessGrowth != null) demandParts.push(sessGrowth);
  const convGrowth = growthToScore(m.agent.conversions.change_pct);
  if (convGrowth != null) demandParts.push(convGrowth);
  const demandScore = demandParts.length
    ? demandParts.reduce((a, b) => a + b, 0) / demandParts.length
    : null;
  drivers.push({
    key: 'demand',
    label: 'Demanda y conversión',
    value: demandScore == null ? null : round(demandScore, 0),
    weight: 0.2,
    detail:
      demandScore == null
        ? 'Sin datos de tráfico'
        : `Visitas ${m.traffic.sessions.change_pct ?? 0}% · conversiones WhatsApp ${m.agent.conversions.change_pct ?? 0}%`,
  });

  // Renormalize weights over the drivers that actually have data.
  const active = drivers.filter((d) => d.value != null);
  const totalWeight = active.reduce((s, d) => s + d.weight, 0);
  const score = totalWeight > 0
    ? round(active.reduce((s, d) => s + (d.value as number) * (d.weight / totalWeight), 0), 0)
    : 0;

  let label = 'critico';
  if (score >= 75) label = 'saludable';
  else if (score >= 55) label = 'estable';
  else if (score >= 35) label = 'en_riesgo';

  return { score, label, drivers };
}
