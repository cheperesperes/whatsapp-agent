'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';
import { createBrowserClient } from '@/lib/supabase';
import type { AgentProduct } from '@/lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  kit: 'Estación Portátil',
  portable_station: 'Estación Portátil',
  battery: 'Batería',
  inverter: 'Inversor',
  panel: 'Panel Solar',
  all_in_one: 'Todo-en-Uno',
  'sistemas-solares-todo-en-uno': 'Todo-en-Uno',
  accessory: 'Accesorio',
};

function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    kit: 'bg-brand-900/50 text-brand-300 border-brand-800',
    portable_station: 'bg-brand-900/50 text-brand-300 border-brand-800',
    battery: 'bg-blue-900/50 text-blue-300 border-blue-800',
    inverter: 'bg-purple-900/50 text-purple-300 border-purple-800',
    panel: 'bg-green-900/50 text-green-300 border-green-800',
    all_in_one: 'bg-orange-900/50 text-orange-300 border-orange-800',
    'sistemas-solares-todo-en-uno': 'bg-orange-900/50 text-orange-300 border-orange-800',
    accessory: 'bg-gray-800 text-gray-400 border-gray-700',
  };
  const color = colors[category] ?? 'bg-gray-800 text-gray-400 border-gray-700';
  return (
    <span className={`inline-flex items-center border rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

interface EditingProduct {
  sell_price: string;
  in_stock: boolean;
  description_short: string;
  ideal_for: string;
}

function formatCapacity(p: AgentProduct): string {
  const parts: string[] = [];
  if (p.battery_capacity_wh) parts.push(`${p.battery_capacity_wh.toLocaleString()} Wh`);
  if (p.battery_capacity_ah) parts.push(`${p.battery_capacity_ah} Ah`);
  if (p.inverter_watts) parts.push(`${p.inverter_watts.toLocaleString()} W inv.`);
  if (p.panel_watts) parts.push(`${p.panel_watts} W panel`);
  if (p.solar_input_watts && !p.panel_watts) parts.push(`${p.solar_input_watts.toLocaleString()} W solar`);
  if (p.output_watts && !p.inverter_watts) parts.push(`${p.output_watts.toLocaleString()} W`);
  return parts.length ? parts.join(' · ') : '—';
}

export default function ProductsPage() {
  const [products, setProducts] = useState<AgentProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditingProduct | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [region, setRegion] = useState<'cuba' | 'usa'>('cuba');

  const supabase = createBrowserClient();

  const loadProducts = useCallback(async () => {
    const { data } = await supabase
      .from('agent_product_catalog')
      .select('*')
      .order('category')
      .order('sell_price');
    setProducts((data as AgentProduct[] | null) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  function startEdit(product: AgentProduct) {
    setEditingId(product.id);
    setEditValues({
      sell_price: product.sell_price?.toString() ?? '0',
      in_stock: product.in_stock ?? true,
      description_short: product.description_short ?? '',
      ideal_for: product.ideal_for ?? '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValues(null);
  }

  async function saveEdit(productId: string) {
    if (!editValues) return;
    setSaving(true);

    const price = parseFloat(editValues.sell_price);
    if (isNaN(price) || price < 0) {
      alert('Precio inválido');
      setSaving(false);
      return;
    }

    // `manually_overridden_at` tells the inventory-sync cron
    // (/api/cron/sync-inventory) to skip this row for the next
    // INVENTORY_SYNC_OVERRIDE_TTL_HOURS so an operator's edit isn't
    // silently reverted on the next sync.
    await supabase
      .from('agent_product_catalog')
      .update({
        sell_price: price,
        in_stock: editValues.in_stock,
        description_short: editValues.description_short || null,
        ideal_for: editValues.ideal_for || null,
        manually_overridden_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId);

    setSaving(false);
    setEditingId(null);
    setEditValues(null);
    setSavedId(productId);
    setTimeout(() => setSavedId(null), 2000);
    await loadProducts();
  }

  const categories = ['all', ...Array.from(new Set(products.map((p) => p.category)))];

  const filtered = products.filter((p) => {
    const matchesCat = categoryFilter === 'all' || p.category === categoryFilter;
    const q = search.toLowerCase();
    const matchesSearch =
      !search ||
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q);
    return matchesCat && matchesSearch;
  });

  const inStockCount = products.filter((p) => p.in_stock).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-surface-600 bg-surface-800 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Catálogo de Productos</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {products.length} productos · {inStockCount} en stock
          </p>
        </div>
        <div className="flex items-center gap-1 bg-surface-700 rounded-lg p-1">
          <button
            onClick={() => setRegion('cuba')}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              region === 'cuba' ? 'bg-whatsapp-500 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Precio Cuba
          </button>
          <button
            onClick={() => setRegion('usa')}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              region === 'usa' ? 'bg-whatsapp-500 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Precio USA
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-surface-600 bg-surface-800 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Buscar por nombre, SKU o marca..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input text-xs w-64"
        />
        <div className="flex gap-1 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors
                ${categoryFilter === cat
                  ? 'bg-whatsapp-500 text-white'
                  : 'bg-surface-700 text-gray-400 hover:text-gray-200'}`}
            >
              {cat === 'all' ? 'Todos' : CATEGORY_LABELS[cat] ?? cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
            Cargando catálogo...
          </div>
        ) : (
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-surface-600 bg-surface-800 sticky top-0">
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3">Producto</th>
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3">Categoría</th>
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3">Capacidad</th>
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3">
                  Precio {region === 'cuba' ? 'Cuba (final)' : 'USA'}
                </th>
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3">Stock</th>
                <th className="text-left text-xs font-medium text-gray-400 px-4 py-3 w-64">Ideal para</th>
                <th className="text-right text-xs font-medium text-gray-400 px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((product) => {
                const isEditing = editingId === product.id;
                const isSaved = savedId === product.id;
                const displayPrice =
                  region === 'cuba'
                    ? (product.cuba_total_price ?? product.sell_price ?? 0)
                    : (product.sell_price ?? 0);

                return (
                  <tr
                    key={product.id}
                    className={`border-b border-surface-700 transition-colors
                      ${isEditing ? 'bg-surface-700' : 'hover:bg-surface-800/50'}`}
                  >
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-200">{product.name}</p>
                        <p className="text-xs text-gray-500 font-mono">{product.sku}</p>
                        <p className="text-xs text-gray-500">{product.brand}</p>
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <CategoryBadge category={product.category} />
                    </td>

                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {formatCapacity(product)}
                    </td>

                    <td className="px-4 py-3">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editValues?.sell_price ?? ''}
                          onChange={(e) =>
                            setEditValues((prev) => prev ? { ...prev, sell_price: e.target.value } : prev)
                          }
                          className="input w-24 text-xs"
                        />
                      ) : (
                        <div>
                          <span className="font-medium text-gray-200">
                            ${Number(displayPrice).toFixed(2)}
                          </span>
                          {region === 'cuba' && (product.cuba_shipping_fee || product.cuba_handling_fee) ? (
                            <p className="text-xs text-gray-500">
                              ${Number(product.sell_price).toFixed(2)} + $
                              {Number(
                                (product.cuba_shipping_fee ?? 0) + (product.cuba_handling_fee ?? 0)
                              ).toFixed(2)} envío
                            </p>
                          ) : null}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {isEditing ? (
                        <button
                          onClick={() =>
                            setEditValues((prev) => prev ? { ...prev, in_stock: !prev.in_stock } : prev)
                          }
                          className={`px-2 py-1 rounded text-xs font-medium transition-colors
                            ${editValues?.in_stock
                              ? 'bg-green-900/50 text-green-300 border border-green-800'
                              : 'bg-red-900/50 text-red-300 border border-red-800'}`}
                        >
                          {editValues?.in_stock ? 'En stock' : 'Sin stock'}
                        </button>
                      ) : (
                        <span className={product.in_stock
                          ? 'text-green-400 text-xs'
                          : 'text-red-400 text-xs'}>
                          {product.in_stock ? '● En stock' : '○ Sin stock'}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editValues?.ideal_for ?? ''}
                          onChange={(e) =>
                            setEditValues((prev) => prev ? { ...prev, ideal_for: e.target.value } : prev)
                          }
                          className="input w-full text-xs"
                          placeholder="Ideal para..."
                        />
                      ) : (
                        <span className="text-xs text-gray-400">{product.ideal_for ?? '—'}</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-right">
                      {isSaved && !isEditing && (
                        <span className="text-xs text-green-400 mr-2">✓ Guardado</span>
                      )}
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="btn-secondary text-xs py-1 px-3"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => saveEdit(product.id)}
                            disabled={saving}
                            className="btn-primary text-xs py-1 px-3"
                          >
                            {saving ? 'Guardando...' : 'Guardar'}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(product)}
                          className="btn-secondary text-xs py-1 px-3"
                        >
                          Editar
                        </button>
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
