'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/business — "Negocio": one screen that answers "are we growing or
// losing money, and how likely is this to work?" It stitches revenue + profit
// (orders), ad cost (Facebook/Google/WhatsApp), website traffic, the WhatsApp
// Sol agent funnel, social engagement and the daily automations into a single
// health view, topped by a probability-of-success score and data-driven
// suggestions. Data: GET /api/business/overview.

// ── API shape (mirrors lib/business-metrics.ts) ─────────────
interface Delta { current: number; previous: number; change_pct: number | null }
interface Driver { key: string; label: string; value: number | null; weight: number; detail: string }
interface Insight { level: 'good' | 'warn' | 'risk'; title: string; detail: string }
interface AutomationRow { key: string; label: string; last_run: string | null; window_count: number; healthy: boolean }
interface DailyPoint { date: string; revenue: number; orders: number; sessions: number }

interface Metrics {
  window_days: number;
  generated_at: string;
  revenue: {
    gross_sales: Delta; net_revenue: Delta; gross_profit: Delta; net_profit: Delta;
    orders: Delta; avg_order_value: Delta; avg_margin_pct: number; refunds: number;
  };
  costs: {
    ad_spend_total: Delta;
    by_channel: { channel: string; spend: number }[];
    expenses: Delta; roas: number | null;
  };
  traffic: { sessions: Delta; events: Delta; conversion_pct: number | null };
  agent: {
    conversations: Delta; conversions: Delta; deep_conversations: number;
    escalated: number; messages_customer: number; messages_sol: number;
  };
  social: {
    facebook: { likes: number; comments: number; shares: number; reach: number };
    instagram: { likes: number; comments: number };
    youtube: { views: number; likes: number };
    has_data: boolean;
  };
  automation: { emails_sent: Delta; rows: AutomationRow[] };
  lifetime: { paid_orders: number; gross_sales: number };
  daily: DailyPoint[];
  success: { score: number; label: string; drivers: Driver[] };
  insights: Insight[];
  meta_ads_live: { today: number; yesterday: number; this_week: number; this_month: number; currency: string } | null;
  meta_ads_configured: boolean;
}

// ── Formatting helpers ──────────────────────────────────────
const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const usd2 = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const intFmt = (n: number) => n.toLocaleString('en-US');

function DeltaBadge({ d, invert = false }: { d: Delta; invert?: boolean }) {
  if (d.change_pct == null) return <span className="text-[11px] text-gray-600">— sin base</span>;
  const up = d.change_pct >= 0;
  const good = invert ? !up : up;
  return (
    <span className={`text-[11px] font-medium ${good ? 'text-green-400' : 'text-red-400'}`}>
      {up ? '▲' : '▼'} {Math.abs(d.change_pct)}%
    </span>
  );
}

function Stat({
  label, value, delta, invert, sub,
}: { label: string; value: string; delta?: Delta; invert?: boolean; sub?: string }) {
  return (
    <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-100 mt-1 leading-tight">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {delta && <DeltaBadge d={delta} invert={invert} />}
        {sub && <span className="text-[11px] text-gray-600">{sub}</span>}
      </div>
    </div>
  );
}

const SCORE_LABELS: Record<string, { text: string; color: string; ring: string }> = {
  saludable: { text: 'Saludable', color: 'text-green-400', ring: 'stroke-green-400' },
  estable: { text: 'Estable', color: 'text-emerald-300', ring: 'stroke-emerald-300' },
  en_riesgo: { text: 'En riesgo', color: 'text-yellow-400', ring: 'stroke-yellow-400' },
  critico: { text: 'Crítico', color: 'text-red-400', ring: 'stroke-red-400' },
};

function ScoreGauge({ score, label }: { score: number; label: string }) {
  const meta = SCORE_LABELS[label] ?? SCORE_LABELS.critico;
  const r = 52;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="relative w-32 h-32 shrink-0">
      <svg viewBox="0 0 120 120" className="w-32 h-32 -rotate-90">
        <circle cx="60" cy="60" r={r} className="stroke-surface-600" strokeWidth="10" fill="none" />
        <circle
          cx="60" cy="60" r={r}
          className={meta.ring}
          strokeWidth="10" fill="none" strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-3xl font-bold ${meta.color}`}>{score}</span>
        <span className="text-[10px] text-gray-500">de 100</span>
      </div>
    </div>
  );
}

// Validated chart hues (see dataviz validator, light surface #FFFFFF):
// teal #008069 for money, blue #2563eb for traffic — CVD-safe, ≥3:1 contrast.
const C_REVENUE = '#008069';
const C_SESSIONS = '#2563eb';

// A single-series daily bar chart. Revenue and sessions are different scales,
// so they render as SMALL MULTIPLES (two of these) — never a dual-axis chart.
// Single series → the title names it, no legend. Baseline-anchored 4px-rounded
// bars, 2px gaps, exact values on hover (the secondary encoding that satisfies
// the sub-3:1 relief rule) and a direct y-max label.
function MiniBars({
  points, color, title, valueOf, format, tip,
}: {
  points: DailyPoint[];
  color: string;
  title: string;
  valueOf: (p: DailyPoint) => number;
  format: (n: number) => string;
  tip: (p: DailyPoint) => string;
}) {
  const max = Math.max(1, ...points.map(valueOf));
  const total = points.reduce((s, p) => s + valueOf(p), 0);
  const first = points[0]?.date.slice(5) ?? '';
  const last = points[points.length - 1]?.date.slice(5) ?? '';
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-300">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
          {title}
        </span>
        <span className="text-[10px] text-gray-600">máx {format(max)}</span>
      </div>
      <div
        className="relative flex items-end gap-[2px] h-28 border-b border-surface-500"
        role="img"
        aria-label={`${title}: total ${format(total)} entre ${first} y ${last}`}
      >
        {points.map((p) => (
          <div key={p.date} className="group relative flex-1 min-w-0 h-full flex items-end">
            <div
              className="w-full rounded-t-[4px] transition-opacity group-hover:opacity-80"
              style={{ height: `${Math.max(2, (valueOf(p) / max) * 100)}%`, backgroundColor: color }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block
                            bg-gray-100 text-surface-800 rounded px-2 py-1 text-[10px] whitespace-nowrap z-10 shadow">
              {p.date.slice(5)} · {tip(p)}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-gray-600 mt-1">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

function DailyChart({ points }: { points: DailyPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-gray-500">Sin datos diarios en el período.</p>;
  }
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <MiniBars
        points={points}
        color={C_REVENUE}
        title="Ventas por día"
        valueOf={(p) => p.revenue}
        format={usd}
        tip={(p) => `${usd(p.revenue)} · ${p.orders} ped.`}
      />
      <MiniBars
        points={points}
        color={C_SESSIONS}
        title="Sesiones por día"
        valueOf={(p) => p.sessions}
        format={intFmt}
        tip={(p) => `${intFmt(p.sessions)} sesiones`}
      />
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

const WINDOWS = [7, 30, 90];
/** Sunday of the current week, YYYY-MM-DD — matches how spend weeks are keyed. */
function currentSunday(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}
const timeAgo = (iso: string | null) => {
  if (!iso) return 'nunca';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return 'hace <1h';
  if (h < 48) return `hace ${Math.round(h)}h`;
  return `hace ${Math.round(h / 24)}d`;
};

export default function BusinessPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/overview?days=${d}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Error');
      else setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  // ── Ad-spend logging (Facebook / Google / WhatsApp) ──────
  interface SpendRow {
    id: string; week_start: string; channel: string; campaign: string | null;
    spend: number; note: string | null;
  }
  const [spendRows, setSpendRows] = useState<SpendRow[]>([]);
  const [form, setForm] = useState({ week_start: currentSunday(), channel: 'google', spend: '', note: '' });
  const [spendMsg, setSpendMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSpend = useCallback(async () => {
    try {
      const res = await fetch('/api/business/ad-spend', { cache: 'no-store' });
      const json = await res.json();
      if (res.ok) setSpendRows(json.rows ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadSpend(); }, [loadSpend]);

  async function addSpend() {
    setSpendMsg(null);
    setSaving(true);
    try {
      const res = await fetch('/api/business/ad-spend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, spend: Number(form.spend) }),
      });
      const json = await res.json();
      if (!res.ok) { setSpendMsg(json.error ?? 'Error'); return; }
      setForm((f) => ({ ...f, spend: '', note: '' }));
      await Promise.all([loadSpend(), load(days)]);
    } catch (e) {
      setSpendMsg(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setSaving(false);
    }
  }
  async function deleteSpend(id: string) {
    await fetch(`/api/business/ad-spend?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadSpend(), load(days)]);
  }

  // ── Run a daily background task on demand ────────────────
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ label: string; ok: boolean; text: string } | null>(null);

  async function runTask(key: string) {
    setRunningTask(key);
    setRunResult(null);
    try {
      const res = await fetch('/api/business/run-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: key }),
      });
      const json = await res.json();
      setRunResult({
        label: json.label ?? key,
        ok: Boolean(json.ok),
        text: json.ok
          ? `Listo en ${json.duration_ms ?? '?'}ms`
          : json.error ?? `Error (${json.status ?? res.status})`,
      });
      // Snapshot/social change the numbers — refresh the board.
      if (json.ok && (key === 'snapshot' || key === 'social')) await load(days);
    } catch (e) {
      setRunResult({ label: key, ok: false, text: e instanceof Error ? e.message : 'Error de red' });
    } finally {
      setRunningTask(null);
    }
  }

  const r = data?.revenue;
  const c = data?.costs;
  const t = data?.traffic;
  const a = data?.agent;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Negocio</h1>
            <p className="text-sm text-gray-500">
              Salud del e-commerce de oiikon.com — ingresos, ganancia, anuncios, tráfico y el agente
              de WhatsApp, con probabilidad de éxito y sugerencias. Últimos {data?.window_days ?? days} días.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-surface-600 overflow-hidden">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setDays(w)}
                  className={`px-3 py-2 text-sm ${
                    days === w ? 'bg-whatsapp-500/15 text-whatsapp-600' : 'text-gray-400 hover:bg-surface-700'
                  }`}
                >
                  {w}d
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => load(days)}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-surface-700 border border-surface-600 text-sm text-gray-300
                         hover:bg-surface-600 disabled:opacity-50"
            >
              {loading ? 'Actualizando…' : '↻'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}
        {loading && !data && <p className="text-sm text-gray-500">Cargando…</p>}

        {data && r && c && t && a && (
          <>
            {/* Probability of success */}
            <div className="bg-surface-800 border border-surface-600 rounded-xl p-5">
              <div className="flex flex-col md:flex-row md:items-center gap-5">
                <ScoreGauge score={data.success.score} label={data.success.label} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-500">Probabilidad de éxito</p>
                  <p className={`text-lg font-semibold ${SCORE_LABELS[data.success.label]?.color ?? 'text-gray-200'}`}>
                    {SCORE_LABELS[data.success.label]?.text ?? data.success.label}
                  </p>
                  <div className="mt-3 grid sm:grid-cols-2 gap-2">
                    {data.success.drivers.map((d) => (
                      <div key={d.key} className="bg-surface-700/40 rounded-lg px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400">{d.label}</span>
                          <span className="text-xs font-medium text-gray-200">
                            {d.value == null ? 's/d' : d.value}
                            <span className="text-gray-600"> · {Math.round(d.weight * 100)}%</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 bg-surface-600 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-whatsapp-500/70"
                            style={{ width: `${d.value ?? 0}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-gray-600 mt-1">{d.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Suggestions */}
            <Section title="Sugerencias" subtitle="Generadas automáticamente a partir de tus datos.">
              <div className="space-y-2">
                {data.insights.map((ins, i) => {
                  const styles = {
                    risk: 'bg-red-500/10 border-red-500/30 text-red-200',
                    warn: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-100',
                    good: 'bg-green-500/10 border-green-500/30 text-green-100',
                  }[ins.level];
                  const icon = { risk: '⛔', warn: '⚠️', good: '✅' }[ins.level];
                  return (
                    <div key={i} className={`border rounded-lg px-4 py-3 ${styles}`}>
                      <p className="text-sm font-medium">{icon} {ins.title}</p>
                      <p className="text-xs opacity-80 mt-0.5">{ins.detail}</p>
                    </div>
                  );
                })}
              </div>
            </Section>

            {/* Money headline */}
            <Section title="Dinero" subtitle="Solo pedidos pagados. Ganancia neta incluye COGS, envío y gastos del pedido.">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Ganancia neta" value={usd2(r.net_profit.current)} delta={r.net_profit} />
                <Stat label="Ventas (bruto)" value={usd2(r.gross_sales.current)} delta={r.gross_sales} />
                <Stat label="Ganancia bruta" value={usd2(r.gross_profit.current)} delta={r.gross_profit} />
                <Stat label="Pedidos pagados" value={intFmt(r.orders.current)} delta={r.orders} />
                <Stat label="Ticket promedio" value={usd2(r.avg_order_value.current)} delta={r.avg_order_value} />
                <Stat label="Margen promedio" value={`${r.avg_margin_pct}%`} sub="del período" />
                <Stat label="Reembolsos" value={usd2(r.refunds)} sub="devueltos" />
                <Stat
                  label="ROAS"
                  value={c.roas == null ? 's/d' : `${c.roas}×`}
                  sub={c.roas == null ? 'sin gasto registrado' : 'ingreso ÷ anuncios'}
                />
              </div>
            </Section>

            {/* Daily trend */}
            <Section title="Tendencia diaria" subtitle="Ventas y visitas por día (pasa el cursor para ver el detalle).">
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <DailyChart points={data.daily} />
              </div>
            </Section>

            {/* Marketing / ad cost */}
            <Section title="Anuncios y costos" subtitle="Facebook, Google y WhatsApp Ads + gastos operativos.">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Gasto en anuncios" value={usd2(c.ad_spend_total.current)} delta={c.ad_spend_total} invert sub="registrado" />
                <Stat label="Gastos operativos" value={usd2(c.expenses.current)} delta={c.expenses} invert />
                {data.meta_ads_live && (
                  <>
                    <Stat label="Meta — este mes" value={usd2(data.meta_ads_live.this_month)} sub="en vivo (API)" />
                    <Stat label="Meta — hoy" value={usd2(data.meta_ads_live.today)} sub="en vivo (API)" />
                  </>
                )}
              </div>
              {c.by_channel.length > 0 ? (
                <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-2">Gasto por canal</p>
                  <div className="space-y-1.5">
                    {c.by_channel.map((ch) => (
                      <div key={ch.channel} className="flex items-center justify-between text-sm">
                        <span className="text-gray-300 capitalize">{ch.channel}</span>
                        <span className="text-gray-200">{usd2(ch.spend)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-surface-800 border border-surface-600 rounded-xl px-4 py-3 text-xs text-gray-500">
                  No hay gasto de anuncios registrado en la tabla <code>ad_spend</code>.
                  {data.meta_ads_configured
                    ? ' Meta está conectado (ver montos arriba); registra Google y WhatsApp Ads para medir el ROAS por canal.'
                    : ' Conecta Meta/Google/WhatsApp Ads o registra el gasto semanal para medir el ROAS.'}
                </div>
              )}

              {/* Manual ad-spend logging */}
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-gray-100">Registrar gasto de anuncios</p>
                  <p className="text-xs text-gray-500">
                    Facebook se sincroniza solo desde Meta. Registra aquí el gasto semanal de Google
                    y WhatsApp Ads para activar el ROAS por canal.
                  </p>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  <select
                    value={form.channel}
                    onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
                    className="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-gray-200"
                  >
                    <option value="google">Google</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="facebook">Facebook</option>
                    <option value="instagram">Instagram</option>
                    <option value="tiktok">TikTok</option>
                    <option value="otro">Otro</option>
                  </select>
                  <input
                    type="date"
                    value={form.week_start}
                    onChange={(e) => setForm((f) => ({ ...f, week_start: e.target.value }))}
                    className="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-gray-200"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    value={form.spend}
                    onChange={(e) => setForm((f) => ({ ...f, spend: e.target.value }))}
                    placeholder="Gasto $"
                    className="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
                  />
                  <input
                    value={form.note}
                    onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    placeholder="Nota (opcional)"
                    className="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
                  />
                  <button
                    type="button"
                    onClick={addSpend}
                    disabled={saving || !form.spend}
                    className="px-3 py-2 rounded-lg bg-whatsapp-500/15 text-whatsapp-600 border border-whatsapp-500/30
                               text-sm font-medium hover:bg-whatsapp-500/25 disabled:opacity-40"
                  >
                    {saving ? 'Guardando…' : 'Agregar'}
                  </button>
                </div>
                {spendMsg && <p className="text-xs text-red-400">{spendMsg}</p>}
                {spendRows.length > 0 && (
                  <div className="space-y-1">
                    {spendRows.slice(0, 8).map((s) => (
                      <div key={s.id} className="flex items-center gap-3 text-xs bg-surface-700/40 rounded-lg px-3 py-2">
                        <span className="w-20 shrink-0 text-gray-400">{s.week_start}</span>
                        <span className="w-24 shrink-0 capitalize text-gray-300">{s.channel}</span>
                        <span className="w-20 shrink-0 text-gray-200">{usd2(s.spend)}</span>
                        <span className="flex-1 min-w-0 truncate text-gray-600">{s.campaign ?? s.note ?? ''}</span>
                        <button type="button" onClick={() => deleteSpend(s.id)} className="shrink-0 text-gray-500 hover:text-red-400">
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>

            {/* Traffic */}
            <Section title="Tráfico del sitio" subtitle="Visitantes y actividad en oiikon.com.">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Sesiones" value={intFmt(t.sessions.current)} delta={t.sessions} />
                <Stat label="Eventos" value={intFmt(t.events.current)} delta={t.events} sub="clics, scroll…" />
                <Stat
                  label="Conversión web"
                  value={t.conversion_pct == null ? 's/d' : `${t.conversion_pct}%`}
                  sub="pedidos ÷ sesiones"
                />
                <Stat label="Ventas de por vida" value={usd(data.lifetime.gross_sales)} sub={`${data.lifetime.paid_orders} pedidos`} />
              </div>
            </Section>

            {/* WhatsApp Sol agent */}
            <Section title="Agente Sol (WhatsApp)" subtitle="El embudo de ventas por WhatsApp.">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Conversaciones" value={intFmt(a.conversations.current)} delta={a.conversations} />
                <Stat label="Conversiones" value={intFmt(a.conversions.current)} delta={a.conversions} />
                <Stat label="Conversaciones profundas" value={intFmt(a.deep_conversations)} sub="≥5 mensajes" />
                <Stat label="Escaladas a humano" value={intFmt(a.escalated)} sub={`${intFmt(a.messages_sol)} msgs de Sol`} />
              </div>
            </Section>

            {/* Social engagement */}
            <Section title="Engagement social" subtitle="Facebook, Instagram y YouTube.">
              {data.social.has_data ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Stat label="Facebook — alcance" value={intFmt(data.social.facebook.reach)} />
                  <Stat label="Facebook — reacciones" value={intFmt(data.social.facebook.likes)} sub={`${data.social.facebook.comments} coment.`} />
                  <Stat label="Facebook — compartidos" value={intFmt(data.social.facebook.shares)} />
                  <Stat label="YouTube — vistas" value={intFmt(data.social.youtube.views)} />
                </div>
              ) : (
                <div className="bg-surface-800 border border-surface-600 rounded-xl px-4 py-3 text-xs text-gray-500">
                  Aún no se recopilan métricas de engagement (tabla <code>marketing_performance</code> vacía).
                  Conecta la API de páginas de Meta para llenar alcance, reacciones y comentarios.
                </div>
              )}
            </Section>

            {/* Daily automations */}
            <Section title="Automatización diaria" subtitle="Los procesos que corren solos y mantienen el negocio. Puedes ejecutarlos ahora mismo.">
              <div className="flex flex-wrap gap-2">
                {[
                  { key: 'snapshot', label: 'Instantánea de negocio' },
                  { key: 'social', label: 'Engagement + gasto FB' },
                  { key: 'marketing', label: 'Contenido de marketing' },
                  { key: 'followups', label: 'Seguimientos' },
                  { key: 'inventory', label: 'Inventario' },
                  { key: 'competitors', label: 'Competencia' },
                ].map((task) => (
                  <button
                    key={task.key}
                    type="button"
                    onClick={() => runTask(task.key)}
                    disabled={runningTask !== null}
                    className="px-3 py-1.5 rounded-lg bg-surface-700 border border-surface-600 text-xs text-gray-300
                               hover:bg-surface-600 disabled:opacity-40"
                  >
                    {runningTask === task.key ? '⏳ Ejecutando…' : `▶ ${task.label}`}
                  </button>
                ))}
              </div>
              {runResult && (
                <div
                  className={`rounded-lg px-3 py-2 text-xs border ${
                    runResult.ok
                      ? 'bg-green-500/10 border-green-500/30 text-green-200'
                      : 'bg-red-500/10 border-red-500/30 text-red-200'
                  }`}
                >
                  {runResult.ok ? '✅' : '⛔'} {runResult.label}: {runResult.text}
                </div>
              )}
              <div className="bg-surface-800 border border-surface-600 rounded-xl divide-y divide-surface-700">
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-gray-300">Correos enviados</span>
                  <span className="text-sm text-gray-200">
                    {intFmt(data.automation.emails_sent.current)} <DeltaBadge d={data.automation.emails_sent} />
                  </span>
                </div>
                {data.automation.rows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${row.healthy ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="text-sm text-gray-300 truncate">{row.label}</span>
                    </div>
                    <span className="text-xs text-gray-500 shrink-0">
                      {row.window_count}× · {timeAgo(row.last_run)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <p className="text-[11px] text-gray-600">
              Actualizado {new Date(data.generated_at).toLocaleString('es-US')}. Una instantánea diaria
              se guarda automáticamente (cron <code>business-snapshot</code>) para construir el histórico.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
