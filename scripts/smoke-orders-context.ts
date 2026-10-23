/**
 * Smoke test for lib/orders-context.ts (no DB) — run with:
 *   npx tsx scripts/smoke-orders-context.ts
 */
import { toCustomerOrder, formatOrdersForPrompt, type OrderRow } from '../lib/orders-context';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };

const base: OrderRow = {
  order_number: 'OIK-1001', created_at: '2026-07-27T10:00:00Z', paid_at: '2026-07-27T10:05:00Z',
  status: 'shipped', payment_status: 'paid', fulfillment_status: 'shipped',
  items: [{ name: 'PECRON E3600LFP', sku: 'E3600LFP', quantity: 1, cost_price: 1 }], total: '999.00',
  shipping_carrier: 'FedEx', tracking_number: '872820410040', tracking_url: 'https://www.fedex.com/fedextrack/?trknbr=872820410040',
  ship_date: '2026-07-28', customer_phone: '+1 (305) 555-0101',
  shipping_address: { address: '123 Private St', city: 'Houston', state: 'TX', phone: '3055550101', fullName: 'Private Name' },
};
const shipped = toCustomerOrder(base);
const block = formatOrdersForPrompt([shipped]);
check('shows order number, item and status', block.includes('#OIK-1001') && block.includes('1× PECRON E3600LFP') && block.includes('enviado'));
check('shows tracking number and link', block.includes('872820410040') && block.includes('fedex.com'));
check('shows city/state only', block.includes('Houston, TX'));
check('never leaks street, name or phone', !block.includes('123 Private St') && !block.includes('Private Name') && !block.includes('555-0101'));
check('never leaks cost', !block.includes('cost_price'));

const noTrack = toCustomerOrder({ ...base, status: 'delivered', fulfillment_status: 'pending', shipping_carrier: null, tracking_number: null, tracking_url: null });
const b2 = formatOrdersForPrompt([noTrack]);
check('delivered-without-tracking says "según nuestro registro"', b2.includes('entregado (según nuestro registro)') && b2.includes('sin rastreo registrado'));
check('processing reads as preparing', formatOrdersForPrompt([toCustomerOrder({ ...base, status: 'processing', fulfillment_status: 'pending', tracking_number: null, shipping_carrier: null })]).includes('preparando el envío'));
check('no orders → empty block', formatOrdersForPrompt([]) === '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
