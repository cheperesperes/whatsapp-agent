/**
 * Supplier order message — the copy-and-paste WhatsApp text the owner forwards
 * to the supplier to fulfil a paid store order (drop-ship).
 *
 * Only what the supplier needs to ship: product + ship-to. Never the customer's
 * email or the price paid.
 */

export interface SupplierOrderItem {
  sku?: string | null;
  mpn?: string | null;
  name?: string | null;
  name_en?: string | null;
  quantity?: number | string | null;
}

export interface SupplierOrderAddress {
  fullName?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface SupplierOrderRow {
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  shipping_address: SupplierOrderAddress | null;
  items: SupplierOrderItem[] | null;
}

function usPhone(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (raw ?? '').trim();
}

/** Returns null when the order lacks what a supplier needs (no item or no address). */
export function buildSupplierOrderMessage(o: SupplierOrderRow, today: Date = new Date()): string | null {
  const items = (o.items ?? []).filter((i) => (i.sku || i.name_en || i.name));
  const a = o.shipping_address ?? {};
  const name = (a.fullName || o.customer_name || '').trim();
  const street = (a.address || '').trim();
  if (items.length === 0 || !name || !street || !a.city || !a.state || !a.zipCode) return null;

  const date = today.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
  });
  const products = items
    .map((i) => {
      const qty = Math.max(1, Number(i.quantity ?? 1) || 1);
      return [
        `*Model / SKU:* ${(i.sku || i.mpn || '').trim() || '—'}`,
        `*Description:* ${(i.name_en || i.name || '').trim()}`,
        `*Quantity:* ${qty}`,
      ].join('\n');
    })
    .join('\n\n');
  const note = (a.notes || '').trim();

  return [
    '*NEW ORDER – Oiikon*',
    '',
    `*Our order #:* ${o.order_number}`,
    `*Date:* ${date}`,
    '',
    '*PRODUCT*',
    products,
    '',
    '*SHIP TO*',
    `*Name:* ${name}`,
    `*Address:* ${street}${a.address2?.trim() ? `, ${a.address2.trim()}` : ''}`,
    `*City, State, ZIP:* ${a.city}, ${a.state} ${a.zipCode}`,
    '*Country:* USA',
    `*Phone:* ${usPhone(a.phone || o.customer_phone)}`,
    ...(note ? ['', `*Notes:* ${note}`] : []),
    '',
    '*PAYMENT*',
    'Please send us the PI (proforma invoice) for this order so we can make the payment. Bill to: CBE Solutions LLC (DBA Oiikon), 5550 Glades Rd, Suite 500, Boca Raton, FL 33431. Please put our order # on the PI.',
    '',
    'Please confirm you received this order, and send the tracking number when it ships. Thank you.',
    'Eduardo – Oiikon',
  ].join('\n');
}
