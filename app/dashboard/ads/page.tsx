'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/ads — which Click-to-WhatsApp ad creative each lead came from,
// with quality, conversions, and a current-stock overlay so a sold-out ad
// target is impossible to miss.

interface AdRow {
  product: string;
  url: string | null;
  sku: string | null;
  in_stock: boolean | null;
  leads: number;
  hot: number;
  warm_plus: number;
  conversions: number;
  conv_rate: number;
  last_lead: string;
}

interface Overview {
  window_days: number;
  totals: { ad_leads: number; organic_leads: number; ad_share_pct: number; ads_to_oos: number };
  ads: AdRow[];
}

export default function AdsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ads/overview', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Error');
      else setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const t = data?.totals;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">Anuncios</h1>
            <p className="text-sm text-gray-500">
              De qué anuncio de Facebook/Instagram llega cada lead de WhatsApp — calidad,
              conversión y si el producto del anuncio está en stock. Últimos {data?.window_days ?? 30} días.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-surface-700 border border-surface-600 text-sm text-gray-300
                       hover:bg-surface-600 transition-colors disabled:opacity-50 shrink-0"
          >
            {loading ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}
        {loading && !data && <p className="text-sm text-gray-500">Cargando…</p>}

        {data && (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Leads de anuncios</p>
                <p className="text-2xl font-semibold text-white mt-1">{t?.ad_leads ?? 0}</p>
              </div>
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">% del total</p>
                <p className="text-2xl font-semibold text-white mt-1">{t?.ad_share_pct ?? 0}%</p>
              </div>
              <div className="bg-surface-800 border border-surface-600 rounded-xl p-4">
                <p className="text-xs text-gray-500">Leads orgánicos</p>
                <p className="text-2xl font-semibold text-white mt-1">{t?.organic_leads ?? 0}</p>
              </div>
              <div
                className={`rounded-xl p-4 border ${
                  (t?.ads_to_oos ?? 0) > 0
                    ? 'bg-red-500/10 border-red-500/40'
                    : 'bg-surface-800 border-surface-600'
                }`}
              >
                <p className="text-xs text-gray-500">Leads → producto AGOTADO</p>
                <p
                  className={`text-2xl font-semibold mt-1 ${
                    (t?.ads_to_oos ?? 0) > 0 ? 'text-red-400' : 'text-white'
                  }`}
                >
                  {t?.ads_to_oos ?? 0}
                </p>
              </div>
            </div>

            {(t?.ads_to_oos ?? 0) > 0 && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-200 rounded-lg px-4 py-3 text-sm">
                ⚠️ <strong>{t?.ads_to_oos}</strong> leads llegaron desde un anuncio cuyo producto está
                AGOTADO. Estás pagando publicidad que manda compradores a un producto sin stock —
                repón el equipo o reapunta el anuncio a uno disponible.
              </div>
            )}

            {/* Per-ad table */}
            <div className="bg-surface-800 border border-surface-600 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-surface-600">
                      <th className="px-4 py-3 font-medium">Anuncio (producto)</th>
                      <th className="px-3 py-3 font-medium text-right">Leads</th>
                      <th className="px-3 py-3 font-medium text-right">Calientes+</th>
                      <th className="px-3 py-3 font-medium text-right">Ventas</th>
                      <th className="px-3 py-3 font-medium text-right">Conv.</th>
                      <th className="px-3 py-3 font-medium text-right">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ads.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                          Sin leads de anuncios todavía.
                        </td>
                      </tr>
                    )}
                    {data.ads.map((a) => (
                      <tr key={a.product} className="border-b border-surface-700/60 last:border-0">
                        <td className="px-4 py-3">
                          <div className="text-gray-200">{a.product}</div>
                          {a.url && (
                            <a
                              href={a.url.startsWith('http') ? a.url : `https://${a.url}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] text-gray-600 hover:text-whatsapp-600 truncate block max-w-xs"
                            >
                              {a.url}
                            </a>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-200">{a.leads}</td>
                        <td className="px-3 py-3 text-right text-gray-300">
                          {a.warm_plus}
                          {a.hot > 0 && <span className="text-orange-400"> · {a.hot}🔥</span>}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-200">{a.conversions}</td>
                        <td className="px-3 py-3 text-right">
                          <span
                            className={
                              a.conv_rate >= 5
                                ? 'text-green-400'
                                : a.conv_rate > 0
                                  ? 'text-yellow-400'
                                  : 'text-gray-500'
                            }
                          >
                            {a.conv_rate}%
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          {a.in_stock === false ? (
                            <span className="text-red-400 text-xs font-medium">⛔ AGOTADO</span>
                          ) : a.in_stock === true ? (
                            <span className="text-green-400/80 text-xs">✓</span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-[11px] text-gray-600">
              "Ventas" cuenta conversaciones marcadas como convertidas o con un pedido del mismo
              teléfono. La atribución viene del referral de Click-to-WhatsApp de Meta (no todos los
              leads traen anuncio — los orgánicos no aparecen aquí).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
