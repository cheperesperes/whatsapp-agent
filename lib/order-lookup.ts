// ============================================================
// Order lookup for Sol — "¿dónde está mi pedido?"
// ============================================================
// Sol used to escalate EVERY order-status question because she had no
// access to orders. This module gives her read-only, verified access:
//
//   1. Detect an order number (ORD-YYMMDD-XXXXXX) in the customer's recent
//      messages.
//   2. Load that order with the service-role client.
//   3. Verify the customer owns it: on WhatsApp the sender's phone must match
//      the order's phone; on the web chat the customer must have typed the
//      email on the order. (An order number alone is NOT proof — it appears
//      on receipts, screenshots and forwarded emails.)
//   4. Return a prompt block. Verified → Sol answers the status herself.
//      Unverified → Sol asks for the email/phone on the order, nothing more.
//
// Nothing here writes to the database.

import { createServiceClient } from './supabase';

export const ORDER_NUMBER_REGEX = /\bORD-\d{6}-[A-Z0-9]{6}\b/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export interface OrderStatusView {
  order_number: string;
  status: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ship_date: string | null;
  created_at: string;
  paid_at: string | null;
  total: number | null;
  items: Array<{ name: string; qty: number }>;
  ship_to: string | null; // "City, ST" only — never the street
  verified: boolean;
}

interface OrderRow {
  order_number: string;
  customer_email: string | null;
  customer_phone: string | null;
  sender_phone: string | null;
  sender_email: string | null;
  status: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ship_date: string | null;
  created_at: string;
  paid_at: string | null;
  total: number | string | null;
  items: unknown;
  shipping_address: unknown;
}

/** Last 10 digits of a phone number — enough to match US numbers written with or without +1. */
function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function findOrderNumber(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = texts[i].match(ORDER_NUMBER_REGEX);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function findEmails(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const m = t.match(new RegExp(EMAIL_REGEX.source, 'gi'));
    if (m) m.forEach((e) => out.add(e.toLowerCase()));
  }
  return [...out];
}

function itemsSummary(items: unknown): Array<{ name: string; qty: number }> {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? o.product_name ?? o.title ?? o.sku ?? '').trim();
      const qty = Number(o.quantity ?? o.qty ?? 1) || 1;
      return name ? { name, qty } : null;
    })
    .filter((x): x is { name: string; qty: number } => !!x)
    .slice(0, 6);
}

function cityState(addr: unknown): string | null {
  if (!addr || typeof addr !== 'object') return null;
  const a = addr as Record<string, unknown>;
  const city = String(a.city ?? '').trim();
  const state = String(a.state ?? a.state_code ?? a.region ?? '').trim();
  if (!city && !state) return null;
  return [city, state].filter(Boolean).join(', ');
}

/**
 * Looks for an order number in the customer's recent messages and, if found,
 * loads and verifies the order. Returns null when no order number is present.
 */
export async function lookupOrderForCustomer(opts: {
  recentUserTexts: string[]; // oldest → newest, including the current message
  channel: 'whatsapp' | 'web';
  senderPhone?: string | null; // WhatsApp only
}): Promise<OrderStatusView | null> {
  const orderNumber = findOrderNumber(opts.recentUserTexts);
  if (!orderNumber) return null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('orders')
    .select(
      'order_number, customer_email, customer_phone, sender_phone, sender_email, status, payment_status, fulfillment_status, shipping_carrier, tracking_number, tracking_url, ship_date, created_at, paid_at, total, items, shipping_address'
    )
    .ilike('order_number', orderNumber)
    .maybeSingle();

  if (error) {
    console.warn('[order-lookup] query failed:', error.message);
    return null;
  }
  if (!data) {
    // Unknown number: tell Sol so she can ask the customer to double-check it.
    return {
      order_number: orderNumber,
      status: 'not_found',
      payment_status: null,
      fulfillment_status: null,
      shipping_carrier: null,
      tracking_number: null,
      tracking_url: null,
      ship_date: null,
      created_at: '',
      paid_at: null,
      total: null,
      items: [],
      ship_to: null,
      verified: false,
    };
  }

  const row = data as OrderRow;

  // ── Ownership check ──
  let verified = false;
  if (opts.channel === 'whatsapp') {
    const sender = phoneKey(opts.senderPhone);
    const onOrder = [phoneKey(row.customer_phone), phoneKey(row.sender_phone)].filter(Boolean);
    verified = !!sender && onOrder.includes(sender);
  }
  if (!verified) {
    const typed = findEmails(opts.recentUserTexts);
    const onOrder = [row.customer_email, row.sender_email]
      .filter((e): e is string => !!e)
      .map((e) => e.toLowerCase());
    verified = typed.some((e) => onOrder.includes(e));
  }

  if (!verified) {
    return {
      order_number: row.order_number,
      status: null,
      payment_status: null,
      fulfillment_status: null,
      shipping_carrier: null,
      tracking_number: null,
      tracking_url: null,
      ship_date: null,
      created_at: '',
      paid_at: null,
      total: null,
      items: [],
      ship_to: null,
      verified: false,
    };
  }

  return {
    order_number: row.order_number,
    status: row.status,
    payment_status: row.payment_status,
    fulfillment_status: row.fulfillment_status,
    shipping_carrier: row.shipping_carrier,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    ship_date: row.ship_date,
    created_at: row.created_at,
    paid_at: row.paid_at,
    total: row.total == null ? null : Number(row.total),
    items: itemsSummary(row.items),
    ship_to: cityState(row.shipping_address),
    verified: true,
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

/**
 * Prompt block for Sol. Verified orders carry the real status so she answers
 * directly; unverified ones only tell her to ask for the email/phone on file.
 */
export function formatOrderForPrompt(o: OrderStatusView | null): string {
  if (!o) return '';
  const lines: string[] = ['', '=== PEDIDO CONSULTADO (dato real del sistema — úsalo, no escales por esto) ==='];

  if (o.status === 'not_found') {
    lines.push(
      `El número ${o.order_number} NO existe en el sistema. Pide al cliente que revise el número en su email de confirmación (formato ORD-AAMMDD-XXXXXX). No inventes un estado.`
    );
    return lines.join('\n') + '\n';
  }

  if (!o.verified) {
    lines.push(
      `Pedido ${o.order_number} encontrado, pero AÚN NO verificado como del cliente. Antes de dar cualquier dato, pídele el email con el que hizo la compra (o que escriba desde el número de teléfono del pedido). No reveles estado, nombre, dirección ni productos hasta verificar.`
    );
    return lines.join('\n') + '\n';
  }

  const items = o.items.length ? o.items.map((i) => `${i.qty}× ${i.name}`).join('; ') : 'sin detalle';
  lines.push(
    `Pedido: ${o.order_number} (verificado ✅)`,
    `Fecha: ${fmtDate(o.created_at)} · Pago: ${o.payment_status ?? '—'}${o.paid_at ? ` (${fmtDate(o.paid_at)})` : ''}`,
    `Estado: ${o.status ?? '—'} · Envío: ${o.fulfillment_status ?? '—'}`,
    `Transportista: ${o.shipping_carrier ?? '—'} · Fecha de envío: ${fmtDate(o.ship_date)}`,
    `Tracking: ${o.tracking_number ?? 'todavía no asignado'}${o.tracking_url ? ` · ${o.tracking_url}` : ''}`,
    `Artículos: ${items}`,
    o.ship_to ? `Destino: ${o.ship_to}` : '',
    o.total != null ? `Total: $${o.total.toFixed(2)}` : '',
    '',
    'Cómo responder: explica el estado en una o dos líneas humanas (pagado → preparando; shipped → ya va en camino con el tracking; delivered → entregado; cancelled/refunded → dilo con claridad y ofrece ayuda). Si hay tracking, dáselo. Si está pagado y sin tracking, di que se prepara en Florida y que recibirá el tracking por email al salir (≈7–10 días hábiles de entrega, a menudo antes). Escala con [HANDOFF: problema con pedido <número>] SOLO si el cliente reporta un problema real (daño, retraso fuera de plazo, cancelación, reembolso, dirección equivocada).'
  );
  return lines.filter((l) => l !== '').join('\n') + '\n';
}
