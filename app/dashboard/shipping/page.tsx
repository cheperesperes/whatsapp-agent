'use client';

import { useCallback, useEffect, useState } from 'react';

// /dashboard/shipping — "Envíos". The operator attaches a carrier tracking number
// to a paid order and marks it shipped. With carrier = FedEx + a tracking number,
// the delivery-alerts cron auto-detects delivery via the FedEx Track API and fires
// the "📦 ¡Llegó!" WhatsApp. Optionally sends the customer a "shipped" update now.

interface Order {
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  total: number;
  items_summary: string;
  fulfillment_status: string;
  tracking_number: string | null;
  tracking_url: string | null;
  shipping_carrier: string | null;
  ship_date: string | null;
  paid_at: string | null;
  created_at: string;
  has_phone: boolean;
}

const CARRIERS = ['FedEx', 'UPS', 'USPS', 'DHL', 'Otro'];

function statusStyle(s: string): { cls: string; label: string } {
  if (s === 'delivered') return { cls: 'bg-emerald-500/15 text-emerald-300', label: 'entregado' };
  if (s === 'shipped') return { cls: 'bg-sky-500/15 text-sky-300', label: 'enviado' };
  return { cls: 'bg-gray-500/15 text-gray-400', label: 'pendiente' };
}

function ShipForm({ order, onDone }: { order: Order; onDone: () => void }) {
  const [carrier, setCarrier] = useState(order.shipping_carrier || 'FedEx');
  const [tracking, setTracking] = useState(order.tracking_number || '');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    const tn = tracking.trim();
    if (!tn) {
      setMsg('Falta el número de rastreo');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/orders/ship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: order.order_number, trackingNumber: tn, carrier, notify }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setMsg(json.error || 'Error al guardar');
        setBusy(false);
        return;
      }
      if (notify && json.notify && json.notify.ok === false) {
        // Saved fine, but the WhatsApp didn't go out — surface why, then refresh.
        setMsg(`Guardado ✓ pero el aviso NO se envió: ${json.notify.error}`);
        setTimeout(onDone, 1800);
        return;
      }
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error de red');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          disabled={busy}
          className="px-2 py-1.5 rounded-lg bg-surface-900 border border-surface-600 text-sm text-gray-200"
        >
          {CARRIERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          disabled={busy}
          placeholder="N.º de rastreo"
          className="flex-1 min-w-[160px] px-2.5 py-1.5 rounded-lg bg-surface-900 border border-surface-600 text-sm text-gray-200 placeholder:text-gray-600 font-mono"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-whatsapp-600/90 hover:bg-whatsapp-600 text-sm text-white font-medium disabled:opacity-50 shrink-0"
        >
          {busy ? 'Guardando…' : order.tracking_number ? 'Actualizar' : 'Marcar enviado'}
        </button>
      </div>
      <label
        className={`flex items-center gap-2 text-xs ${order.has_phone ? 'text-gray-400' : 'text-gray-600'}`}
        title={order.has_phone ? '' : 'Este pedido no tiene teléfono de WhatsApp'}
      >
        <input
          type="checkbox"
          checked={notify && order.has_phone}
          disabled={busy || !order.has_phone}
          onChange={(e) => setNotify(e.target.checked)}
          className="accent-whatsapp-600"
        />
        Avisar al cliente por WhatsApp que su pedido va en camino
        {!order.has_phone && ' (sin teléfono)'}
      </label>
      {msg && <p className="text-xs text-amber-300">{msg}</p>}
    </div>
  );
}

function OrderCard({ order, onDone }: { order: Order; onDone: () => void }) {
  const st = statusStyle(order.fulfillment_status);
  const waLink = order.has_phone
    ? `https://wa.me/${(order.customer_phone ?? '').replace(/[^\d]/g, '')}`
    : null;
  return (
    <div className="border border-surface-600 rounded-lg p-3 space-y-2.5 bg-surface-900/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-gray-100 font-medium">{order.customer_name ?? 'Sin nombre'}</span>
        {waLink ? (
          <a href={waLink} target="_blank" rel="noreferrer" className="text-emerald-300 hover:underline">
            {order.customer_phone}
          </a>
        ) : (
          <span className="text-gray-600">sin teléfono</span>
        )}
        <span className="font-mono text-xs text-gray-500">{order.order_number}</span>
        <span className="text-emerald-300 font-medium">${order.total.toFixed(2)}</span>
        <span className={`px-1.5 py-0.5 rounded text-xs ${st.cls}`}>{st.label}</span>
      </div>
      {order.items_summary && <p className="text-xs text-gray-400">{order.items_summary}</p>}
      {order.tracking_number && (
        <p className="text-xs text-gray-400">
          🚚 {order.shipping_carrier ?? ''}{' '}
          {order.tracking_url ? (
            <a href={order.tracking_url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline font-mono">
              {order.tracking_number}
            </a>
          ) : (
            <span className="font-mono text-gray-300">{order.tracking_number}</span>
          )}
          {order.ship_date && <span className="text-gray-600"> · enviado {order.ship_date}</span>}
        </p>
      )}
      <ShipForm order={order} onDone={onDone} />
    </div>
  );
}

export default function ShippingPage() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/orders/list', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) setError(json.error ?? 'Error');
      else setOrders(json.orders as Order[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toShip = (orders ?? []).filter((o) => !o.tracking_number);
  const tracked = (orders ?? []).filter((o) => o.tracking_number);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Envíos</h1>
            <p className="text-sm text-gray-500">
              Pega el número de rastreo de FedEx en cada pedido pagado. Con FedEx, el sistema detecta
              la entrega solo y le avisa al cliente cuando el paquete llega a su puerta.
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
        {loading && !orders && <p className="text-sm text-gray-500">Cargando…</p>}

        {orders && (
          <>
            <section className="bg-surface-800 border border-amber-500/40 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-amber-300">
                📦 Por enviar — sin rastreo ({toShip.length})
              </h2>
              {toShip.length === 0 && (
                <p className="text-sm text-gray-500">Todo lo pagado ya tiene rastreo 🎉</p>
              )}
              {toShip.map((o) => (
                <OrderCard key={o.order_number} order={o} onDone={load} />
              ))}
            </section>

            <section className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-sky-300">🚚 Con rastreo ({tracked.length})</h2>
              {tracked.length === 0 && <p className="text-sm text-gray-500">Aún nada enviado.</p>}
              {tracked.map((o) => (
                <OrderCard key={o.order_number} order={o} onDone={load} />
              ))}
            </section>

            <p className="text-xs text-gray-600">
              Solo pedidos pagados (últimos 120 días). PECRON envía desde su propia cuenta de FedEx; aquí
              solo registramos el número para rastrear. La alerta de entrega corre en modo simulación hasta
              activar <code className="text-gray-500">DELIVERY_ALERTS_ENABLED</code> y las llaves de FedEx.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
