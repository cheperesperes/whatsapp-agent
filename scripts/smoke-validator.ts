/**
 * Smoke test for lib/validate-reply.ts — run with: npx tsx scripts/smoke-validator.ts
 * Cases mirror real 2026-06-11 production messages (Will/Kerenski E1000 pitch).
 */
import { validateSolReply, extractCheckoutUrls } from '../lib/validate-reply';
import type { AgentProduct } from '../lib/types';

const cat = (sku: string, in_stock: boolean): AgentProduct =>
  ({ sku, in_stock, name: sku, sell_price: 100 } as unknown as AgentProduct);

const CATALOG = [cat('E3600LFP', true), cat('F5000LFP', true), cat('F3000LFP', false)];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
}

// 1. Real Will/Kerenski case: discontinued E1000 pitched with price + link → paragraph dropped.
const willReply = `Great question! Here are the best fits:

🔋 *PECRON E1000LFP* — ~$369.00~ *$332.10* 🔥 _10% off_ · free US shipping
👉 https://oiikon.com/product/pecron-e1000lfp
_Lights + fan + TV + phones._

⚡ *PECRON E3600LFP* — ~$1,049.00~ *$996.55* 🔥 · free US shipping
👉 https://oiikon.com/product/pecron-e3600lfp

What state are you in?`;
const r1 = validateSolReply(willReply, CATALOG, { language: 'en' });
check('E1000 pitch dropped', !r1.text.includes('E1000LFP') && r1.violations.some(v => v.rule === 'oos_product_pitch'));
check('in-stock E3600 kept', r1.text.includes('E3600LFP') && r1.text.includes('996.55'));
check('blockedSkus reports E1000LFP', r1.blockedSkus.includes('E1000LFP'));

// 2. Honest OOS disclosure (price mentioned but clearly agotado) → kept.
const disclosure = `El *F3000LFP* ($799) está agotado temporalmente — regresa el 15 de junio. Mientras tanto le recomiendo el *E3600LFP*:\n\n⚡ *PECRON E3600LFP* — *$996.55* 👉 https://oiikon.com/product/pecron-e3600lfp`;
const r2 = validateSolReply(disclosure, CATALOG, { language: 'es' });
check('honest agotado disclosure kept', r2.text.includes('F3000LFP') && r2.violations.every(v => v.rule !== 'oos_product_pitch'));

// 3. Catalog-OOS (not discontinued) pitch with link → dropped.
const f3000Pitch = `🏆 *PECRON F3000LFP* — *$799.00* · envío gratis\n👉 https://oiikon.com/product/pecron-f3000lfp`;
const r3 = validateSolReply(f3000Pitch, CATALOG, { language: 'es' });
check('catalog-OOS F3000 pitch dropped → fallback', !r3.text.includes('F3000LFP') && r3.text.length > 0);

// 4. Fake checkout URL (model-invented, present pre-swap) → stripped; legit one kept.
const pre = 'Pague aquí: https://www.paypal.com/checkoutnow?token=FAKE123';
const post = `Pague aquí: https://www.paypal.com/checkoutnow?token=FAKE123\n\n💳 Tu link real: https://www.paypal.com/checkoutnow?token=REAL999`;
const r4 = validateSolReply(post, CATALOG, { hallucinatedPaymentUrls: extractCheckoutUrls(pre), language: 'es' });
check('fake checkout URL stripped', !r4.text.includes('FAKE123') && r4.violations.some(v => v.rule === 'fake_payment_link'));
check('legit checkout URL kept', r4.text.includes('REAL999'));

// 5. forbidAllPaymentUrls (web widget): any checkout URL goes.
const r5 = validateSolReply(post, CATALOG, { forbidAllPaymentUrls: true, language: 'es' });
check('widget: all checkout URLs stripped', !r5.text.includes('checkoutnow'));

// 6. Residual markers stripped.
const r6 = validateSolReply('Aquí tiene 👇\n[[PAYLINK items=E3600LFP:1 coupon=none fl=no]]\n[SEND_IMAGE:E3600LFP]', CATALOG, { language: 'es' });
check('markers stripped', !/PAYLINK|SEND_IMAGE/.test(r6.text) && r6.violations.some(v => v.rule === 'residual_marker'));

// 7. Delivery promise → log-only violation, text unchanged.
const dp = 'Su pedido llega en 5 días hábiles a su puerta.';
const r7 = validateSolReply(dp, CATALOG, { language: 'es' });
check('delivery promise flagged (log-only)', r7.violations.some(v => v.rule === 'delivery_promise') && r7.text === dp);

// 8. Runtime claim is NOT a delivery promise.
const rt = 'Mantiene nevera + ventilador + TV por casi 2 días sin recargar. Envío gratis en EE.UU.';
const r8 = validateSolReply(rt, CATALOG, { language: 'es' });
check('runtime claim not flagged', r8.violations.every(v => v.rule !== 'delivery_promise'));

// 9. Clean reply passes untouched.
const clean = `⚡ *PECRON E3600LFP* — *$996.55* · envío gratis\n👉 https://oiikon.com/product/pecron-e3600lfp\n\n¿Lo dejamos listo?`;
const r9 = validateSolReply(clean, CATALOG, { language: 'es' });
check('clean reply untouched', r9.text === clean && r9.violations.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
