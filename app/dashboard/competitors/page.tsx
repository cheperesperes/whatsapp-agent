'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createBrowserClient } from '@/lib/supabase';
import type { CompetitorModel } from '@/lib/types';

// Same brands the seed migration covers — keeps the filter chips stable
// even when the table is empty.
const BRANDS = ['EcoFlow', 'Jackery', 'Bluetti', 'Anker SOLIX', 'Goal Zero'] as const;

interface EditValues {
  current_price_usd: string;
  capacity_wh: string;
  inverter_watts: string;
  source_url: string;
  notes: string;
  active: boolean;
}

function dollarsPerWh(price: number, wh: number): number {
  if (!wh) return 0;
  return price / wh;
}

function formatRefresh(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 30) return `hace ${days}d`;
  return d.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' });
}

export default function CompetitorsPage() {
  const [rows, setRows] = useState<CompetitorModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState<string>('all');
  const [hideInactive, setHideInactive] = useState(true);

  const supabase = createBrowserClient();

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('competitor_models')
      .select('*')
      .order('brand')
      .order('capacity_wh');
    setRows((data as CompetitorModel[] | null) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(c: CompetitorModel) {
    setEditingId(c.id);
    setEditValues({
      current_price_usd: c.current_price_usd?.toString() ?? '0',
      capacity_wh: c.capacity_wh?.toString() ?? '0',
      inverter_watts: c.inverter_watts?.toString() ?? '',
      source_url: c.source_url ?? '',
      notes: c.notes ?? '',
      active: c.active,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValues(null);
  }

  async function saveEdit(id: string) {
    if (!editValues) return;
    setSaving(true);
    const price = parseFloat(editValues.current_price_usd);
    const wh = parseInt(editValues.capacity_wh, 10);
    const inv = editValues.inverter_watts ? parseInt(editValues.inverter_watts, 10) : null;
    if (!isFinite(price) || price < 0 || !isFinite(wh) || wh <= 0) {
      alert('Precio y capacidad Wh deben ser números positivos.');
      setSaving(false);
      return;
    }

    // `manually_overridden_at` blocks the auto-refresh cron from clobbering
    // an operator edit for COMPETITOR_REFRESH_OVERRIDE_TTL_HOURS (default 7d).
    // Mirrors the agent_product_catalog pattern.
    await supabase
      .from('competitor_models')
      .update({
        current_price_usd: price,
        capacity_wh: wh,
        inverter_watts: inv,
        source_url: editValues.source_url.trim() || null,
        notes: editValues.notes.trim() || null,
        active: editValues.active,
        manually_overridden_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    setSaving(false);
    setEditingId(null);
    setEditValues(null);
    setSavedId(id);
    setTimeout(() => setSavedId(null), 2000);
    await load();
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (hideInactive && !r.active) return false;
      if (brandFilter !== 'all' && r.brand !== brandFilter) return false;
      const q = search.toLowerCase();
      if (q) {
        return r.brand.toLowerCase().includes(q) || r.model.toLowerCase().includes(q);
      }
      return true;
    });
  }, [rows, hideInactive, brandFilter, search]);

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-surface-600 bg-surface-800 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Competencia</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {rows.length} modelos · {activeCount} activos · auto-refresh semanal
          </p>
        </div>
        <p className="text-xs text-gray-500 hidden md:block max-w-md text-right">
          Sol usa estos datos para pivotar a $/Wh cuando un cliente menciona otra marca.
          Edita un precio si cambia — la edición bloquea el refresh automático por 7 días.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-surface-600 bg-surface-800 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Buscar marca o modelo..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input text-xs w-64"
        />
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setBrandFilter('all')}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              brandFilter === 'all' ? 'bg-brand-500 text-white' : 'bg-surface-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            Todas
          </button>
          {BRANDS.map((b) => (
            <button
              key={b}
              onClick={() => setBrandFilter(b)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                brandFilter === b ? 'bg-brand-500 text-white' : 'bg-surface-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-400 ml-auto">
          <input
            type="checkbox"
            checked={hideInactive}
            onChange={(e) => setHideInactive(e.target.checked)}
            className="rounded border-surface-500"
          />
          Ocultar inactivos
        </label>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="text-center text-gray-600 text-sm py-8">Cargando…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-600 text-sm py-8">Sin resultados</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-surface-800 sticky top-0 z-10">
              <tr className="text-left text-gray-500 border-b border-surface-600">
                <th className="px-4 py-2 font-medium">Marca</th>
                <th className="px-4 py-2 font-medium">Modelo</th>
                <th className="px-4 py-2 font-medium text-right">Wh</th>
                <th className="px-4 py-2 font-medium text-right">W inv.</th>
                <th className="px-4 py-2 font-medium text-right">Precio USD</th>
                <th className="px-4 py-2 font-medium text-right">$/Wh</th>
                <th className="px-4 py-2 font-medium">Química</th>
                <th className="px-4 py-2 font-medium">Garantía</th>
                <th className="px-4 py-2 font-medium">Refresh</th>
                <th className="px-4 py-2 font-medium">Activo</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const isEditing = editingId === c.id;
                const rate = dollarsPerWh(c.current_price_usd, c.capacity_wh);
                const overrideRecent =
                  c.manually_overridden_at &&
                  Date.now() - new Date(c.manually_overridden_at).getTime() < 7 * 24 * 60 * 60 * 1000;
                return (
                  <tr
                    key={c.id}
                    className={`border-b border-surface-700 hover:bg-surface-800/50 ${
                      !c.active ? 'opacity-50' : ''
                    } ${savedId === c.id ? 'bg-green-900/20' : ''}`}
                  >
                    <td className="px-4 py-2 text-gray-300">{c.brand}</td>
                    <td className="px-4 py-2 text-gray-200 font-medium">{c.model}</td>
                    <td className="px-4 py-2 text-right text-gray-300 tabular-nums">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editValues!.capacity_wh}
                          onChange={(e) =>
                            setEditValues({ ...editValues!, capacity_wh: e.target.value })
                          }
                          className="input text-xs w-20 text-right"
                        />
                      ) : (
                        c.capacity_wh.toLocaleString()
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-400 tabular-nums">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editValues!.inverter_watts}
                          onChange={(e) =>
                            setEditValues({ ...editValues!, inverter_watts: e.target.value })
                          }
                          className="input text-xs w-20 text-right"
                        />
                      ) : (
                        c.inverter_watts?.toLocaleString() ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-200 tabular-nums">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          value={editValues!.current_price_usd}
                          onChange={(e) =>
                            setEditValues({ ...editValues!, current_price_usd: e.target.value })
                          }
                          className="input text-xs w-24 text-right"
                        />
                      ) : (
                        `$${c.current_price_usd.toFixed(0)}`
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-brand-400 tabular-nums font-medium">
                      ${rate.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-gray-400">{c.chemistry ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-400 tabular-nums">
                      {c.warranty_years ? `${c.warranty_years}y` : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-[11px]">
                      {formatRefresh(c.last_refreshed_at)}
                      {overrideRecent && (
                        <span className="ml-1 text-yellow-500" title="Edición manual reciente — auto-refresh pausado">
                          🔒
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={editValues!.active}
                          onChange={(e) => setEditValues({ ...editValues!, active: e.target.checked })}
                          className="rounded"
                        />
                      ) : c.active ? (
                        <span className="text-green-500">●</span>
                      ) : (
                        <span className="text-gray-600">○</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => saveEdit(c.id)}
                            disabled={saving}
                            className="btn-primary text-[11px] px-2 py-1"
                          >
                            {saving ? '…' : 'OK'}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="btn-secondary text-[11px] px-2 py-1"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          {c.source_url && (
                            <a
                              href={c.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-whatsapp-600 hover:text-whatsapp-500 text-[11px]"
                              title="Ver página oficial"
                            >
                              🔗
                            </a>
                          )}
                          <button
                            onClick={() => startEdit(c)}
                            className="btn-secondary text-[11px] px-2 py-1"
                          >
                            Editar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
