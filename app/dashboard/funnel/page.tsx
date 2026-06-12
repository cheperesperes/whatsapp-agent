'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/funnel — the Sol conversion funnel. Of the WhatsApp leads that
// arrive, how many survive each step (turn-1 reply → reached a link → reached a
// pay-link → paid), for the last 7 and 30 days and by ad source. Built after the
// 2026-06-12 audit so each shipped fix can be measured against a real rate.

interface StageRates {
  convos: number;
  turn1_reply: number;
  reached_link: number;
  reached_paylink: number;
  paid: number;
  pct_turn1_reply: number;
  pct_reached_link: number;
  pct_reached_paylink: number;
  pct_paid: number;
}

interface FunnelData {
  lookback_days: number;
  generated_at: string;
  windows: { last_7d: StageRates; last_30d: StageRates };
  by_source_30d: Record<string, StageRates>;
}

const STEPS: Array<{ key: keyof StageRates; pct: keyof StageRates; label: string }> = [
  { key: 'convos', pct: 'convos', label: 'Chats' },
  { key: 'turn1_reply', pct: 'pct_turn1_reply', label: 'Respondió turno 1' },
  { key: 'reached_link', pct: 'pct_reached_link', label: 'Recibió link' },
  { key: 'reached_paylink', pct: 'pct_reached_paylink', label: 'Recibió pay-link' },
  { key: 'paid', pct: 'pct_paid', label: 'Pagó' },
];

function Bar({ pct, danger }: { pct: number; danger?: boolean }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 4, height: 8, width: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.max(2, Math.min(100, pct))}%`,
          height: '100%',
          background: danger ? '#ef4444' : '#22c55e',
        }}
      />
    </div>
  );
}

function FunnelTable({ s }: { s: StageRates }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <tbody>
        {STEPS.map((step) => {
          const n = s[step.key] as number;
          const pct = step.key === 'convos' ? 100 : (s[step.pct] as number);
          const danger = step.key !== 'convos' && pct < 50;
          return (
            <tr key={step.key} style={{ borderBottom: '1px solid #1e293b' }}>
              <td style={{ padding: '8px 12px 8px 0', whiteSpace: 'nowrap', color: '#cbd5e1' }}>{step.label}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{n}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: danger ? '#f87171' : '#94a3b8', width: 64, fontVariantNumeric: 'tabular-nums' }}>
                {step.key === 'convos' ? '—' : `${pct}%`}
              </td>
              <td style={{ padding: '8px 0', width: '40%' }}>{step.key === 'convos' ? null : <Bar pct={pct} danger={danger} />}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  F5000: 'Ad F5000 ($1,899)',
  E3600: 'Ad E3600 ($949)',
  other_ad: 'Otros ads',
  no_ad: 'Sin atribución',
};

export default function FunnelPage() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/stats/funnel');
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'error');
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, color: '#e2e8f0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Embudo de conversión — Sol (WhatsApp)</h1>
        <button onClick={load} style={{ background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>
          ↻ Actualizar
        </button>
      </div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        Cuántos leads sobreviven cada paso. Mide si los arreglos mueven la tasa. Rojo = bajo 50%.
      </p>

      {loading && <p style={{ color: '#94a3b8' }}>Cargando…</p>}
      {error && <p style={{ color: '#f87171' }}>Error: {error}</p>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 16 }}>
            <section>
              <h2 style={{ fontSize: 15, color: '#cbd5e1', borderBottom: '2px solid #334155', paddingBottom: 6 }}>Últimos 7 días</h2>
              <FunnelTable s={data.windows.last_7d} />
            </section>
            <section>
              <h2 style={{ fontSize: 15, color: '#cbd5e1', borderBottom: '2px solid #334155', paddingBottom: 6 }}>Últimos 30 días</h2>
              <FunnelTable s={data.windows.last_30d} />
            </section>
          </div>

          <h2 style={{ fontSize: 15, color: '#cbd5e1', borderBottom: '2px solid #334155', paddingBottom: 6, marginTop: 32 }}>
            Por fuente de tráfico (30 días)
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 8 }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'right', fontSize: 12 }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Fuente</th>
                <th style={{ padding: '6px 8px' }}>Chats</th>
                <th style={{ padding: '6px 8px' }}>Resp. T1</th>
                <th style={{ padding: '6px 8px' }}>Link</th>
                <th style={{ padding: '6px 8px' }}>Pay-link</th>
                <th style={{ padding: '6px 8px' }}>Pagó</th>
              </tr>
            </thead>
            <tbody>
              {['F5000', 'E3600', 'other_ad', 'no_ad'].map((k) => {
                const s = data.by_source_30d[k];
                if (!s) return null;
                return (
                  <tr key={k} style={{ borderBottom: '1px solid #1e293b', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <td style={{ textAlign: 'left', padding: '8px', color: '#cbd5e1' }}>{SOURCE_LABEL[k] ?? k}</td>
                    <td style={{ padding: '8px' }}>{s.convos}</td>
                    <td style={{ padding: '8px', color: s.pct_turn1_reply < 50 ? '#f87171' : '#94a3b8' }}>{s.pct_turn1_reply}%</td>
                    <td style={{ padding: '8px', color: '#94a3b8' }}>{s.pct_reached_link}%</td>
                    <td style={{ padding: '8px', color: '#94a3b8' }}>{s.pct_reached_paylink}%</td>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{s.paid}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p style={{ color: '#64748b', fontSize: 12, marginTop: 16 }}>
            Generado {new Date(data.generated_at).toLocaleString()} · ventana {data.lookback_days}d · webhook firmado (sin prueba CLI; mide con leads reales).
          </p>
        </>
      )}
    </div>
  );
}
