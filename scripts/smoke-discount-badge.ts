import { formatProductCatalogForPrompt } from '../lib/supabase';
import type { AgentProduct } from '../lib/types';

const mk = (sku: string, sell: number, original: number | null, disc: number, in_stock = true): AgentProduct =>
  ({ sku, name: `PECRON ${sku}`, category: 'kit', brand: 'PECRON', sell_price: sell,
     original_price: original, discount_percentage: disc, in_stock, stock_quantity: in_stock ? 10 : 0 } as unknown as AgentProduct);

const out = formatProductCatalogForPrompt([
  mk('E2000LFP', 599, 1499, 0),    // synced: 60% off hook
  mk('E3600LFP', 999, 2299, 0),    // 57%
  mk('EB3000-24V', 499, 1499, 0),  // 67%
  mk('F5000LFP', 1999, null, 0),   // null MSRP → no badge
  mk('NOMARKDOWN', 500, 400, 0),   // MSRP < price → no badge
  mk('LEGACYDISC', 1000, 2000, 10),// disc 10 → effective 900, badge from 2000
]);

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

ck('E2000 shows $599 + 60% off $1499', out.includes('Precio $599.00') && /E2000LFP[^\n]*antes \$1499\.00, 60% descuento/.test(out));
ck('E3600 shows $999 + 57% off $2299', /E3600LFP[^\n]*Precio \$999\.00[^\n]*antes \$2299\.00, 57% descuento/.test(out));
ck('EB3000 shows 67% off', /EB3000-24V[^\n]*antes \$1499\.00, 67% descuento/.test(out));
ck('F5000 (null MSRP) shows price, NO badge', out.includes('Precio $1999.00') && !/F5000LFP[^\n]*antes/.test(out));
ck('NOMARKDOWN (MSRP<price) NO badge', /NOMARKDOWN[^\n]*Precio \$500\.00/.test(out) && !/NOMARKDOWN[^\n]*antes/.test(out));
ck('LEGACYDISC effective $900 + 55% off $2000', /LEGACYDISC[^\n]*Precio \$900\.00[^\n]*antes \$2000\.00, 55% descuento/.test(out));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('--- sample line:\n' + out.split('\n').find(l => l.includes('E2000LFP')));
process.exit(fail ? 1 : 0);
