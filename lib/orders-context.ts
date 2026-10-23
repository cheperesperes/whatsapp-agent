/**
 * Post-sale context: the customer's own PAID orders, matched by WhatsApp number,
 * so Sol can answer "¿dónde está mi pedido?" herself instead of escalating.
 *
 * Why: on 2026-08-11 a buyer ($3,739 order) asked about FedEx calls; Sol could
 * only hand off and the answer came ~10 hours later. The order (status, carrier)
 * was already in the `orders` table.
 *
 * Privacy: only orders whose customer_phone / shipping phone match the sender's
 * number (last 10 digits). Street address, email and phone are never put in the
 * prompt — only city/state, items, status and tracking.
 */
import { createServiceClient } from './supabase';

export interface CustomerOrder {
  orderNumber: string;
  paidOn: string | null;
  items: { name: string; qty: number }[];
  total: number | null;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipDate: string | null;
  city: string | null;
  state: string | null;
}

const last10 = (s: unknown): string => String(s ?? '').replace(/\D/g, '').slice(-10);

export type OrderRow = {
  order_number: string | null;
  provisionalOrderNumber?: string | null;
  created_at: string;
  paid_at: string | null;
  status: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  items: unknown;
  total: number | string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ship_date: string | null;
  customer_phone: string | null;
  shipping_address: unknown;
};

/** Paid orders for this WhatsApp number, newest first (max 5, last 12 months). */
export async function loadCustomerOrders(phone: string): Promise<CustomerOrder[]> {
  const want = last10(phone);
  if (want.length < 10) return [];
  try {
    const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await createServiceClient()
      .from('orders')
      .select('order_number, created_at, paid_at, status, payment_status, fulfillment_status, items, total, shipping_carrier, tracking_number, tracking_url, ship_date, customer_phone, shipping_address')
      .eq('payment_status', 'paid')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error || !data) return [];
    return (data as OrderRow[])
      .filter((o) => {
        const addr = (o.shipping_address ?? {}) as { phone?: unknown };
        return last10(o.customer_phone) === want || last10(addr.phone) === want;
      })
      .slice(0, 5)
      .map(toCustomerOrder);
  } catch {
    return []; // never block a reply on post-sale context
  }
}

export function toCustomerOrder(o: OrderRow): CustomerOrder {
  const addr = (o.shipping_address ?? {}) as { city?: unknown; state?: unknown };
  const rawItems = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  const items = rawItems.map((it) => ({
    name: String(it.name_public ?? it.name ?? it.sku ?? 'Producto'),
    qty: Number(it.quantity ?? 1) || 1,
  }));
  const tracking = o.tracking_number?.trim() || null;
  return {
    orderNumber: o.order_number ?? '(sin número)',
    paidOn: (o.paid_at ?? o.created_at)?.slice(0, 10) ?? null,
    items,
    total: o.total == null ? null : Number(o.total),
    // Prefer the fulfillment status when it carries shipping info; `status`
    // alone is sometimes set to "delivered" with no carrier on record.
    status: tracking || o.shipping_carrier ? (o.fulfillment_status || o.status || 'unknown') : (o.status || 'unknown'),
    carrier: o.shipping_carrier?.trim() || null,
    trackingNumber: tracking,
    trackingUrl: o.tracking_url?.trim() || null,
    shipDate: o.ship_date?.slice(0, 10) ?? null,
    city: typeof addr.city === 'string' ? addr.city : null,
    state: typeof addr.state === 'string' ? addr.state : null,
  };
}

const STATUS_ES: Record<string, string> = {
  processing: 'pagado, preparando el envío',
  pending: 'pagado, preparando el envío',
  shipped: 'enviado',
  fulfilled: 'enviado',
  delivered: 'entregado (según nuestro registro)',
  cancelled: 'cancelado',
};

export function formatOrdersForPrompt(orders: CustomerOrder[]): string {
  if (orders.length === 0) return '';
  const lines = orders.map((o) => {
    const items = o.items.map((i) => `${i.qty}× ${i.name}`).join(' + ') || 'productos';
    const ship = o.trackingNumber
      ? `envío: ${o.carrier ?? 'transportista'} · rastreo ${o.trackingNumber}${o.trackingUrl ? ` · ${o.trackingUrl}` : ''}`
      : o.carrier
        ? `envío: ${o.carrier} (sin número de rastreo registrado)`
        : 'sin rastreo registrado todavía';
    const where = [o.city, o.state].filter(Boolean).join(', ');
    return `• Pedido #${o.orderNumber} · pagado ${o.paidOn ?? '—'} · ${items}${o.total != null ? ` · total $${o.total.toFixed(2)}` : ''} · estado: ${STATUS_ES[o.status] ?? o.status} · ${ship}${where ? ` · destino: ${where}` : ''}`;
  });
  return [
    '',
    '=== PEDIDOS DE ESTE CLIENTE (verificados por su número de WhatsApp — dato real del sistema) ===',
    ...lines,
    'Cómo usarlo (posventa):',
    '• "¿Dónde está mi pedido?" → responde TÚ con estos datos en 1–2 líneas. Con rastreo: dalo con su link. Sin rastreo: "ya está pagado y lo estamos preparando; le mando el rastreo apenas salga" — sin fechas.',
    '• Puedes confirmar ciudad y estado del envío. Nunca escribas la dirección completa, el email ni el teléfono.',
    '• Solo hablas de los pedidos de esta lista. Si preguntan por otro pedido u otra persona, pide que escriban desde el número de la compra o escala.',
    '• Si el registro dice "entregado" y el cliente dice que no le llegó, o hay daño, pieza faltante, cobro raro, devolución o garantía: no discutas el registro. Reúne lo que pasó (y fotos si las tiene) y escala con [HANDOFF: posventa — pedido #N — resumen en una línea].',
    '',
  ].join('\n');
}
