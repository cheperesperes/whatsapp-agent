import { buildWebLeadFollowupEmail } from '../lib/email';

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

const es = buildWebLeadFollowupEmail({
  language: 'es',
  productName: 'PECRON F5000LFP',
  productPrice: 1999,
  productUrl: 'https://oiikon.com/product/pecron-f5000lfp-7200w-5120wh-lifepo4-120v240v-d2629ee6?promo=SUMMER100',
  couponCode: 'SUMMER100',
  couponSavings: 100,
  unsubscribeUrl: 'https://whatsapp-agent-ebon-nine.vercel.app/api/web-leads/unsubscribe?id=abc&lang=es',
});
ck('ES subject', es.subject.includes('pendiente'));
ck('product + price', es.html.includes('F5000LFP') && es.html.includes('$1999.00'));
ck('coupon block', es.html.includes('SUMMER100') && es.html.includes('$100.00'));
ck('WhatsApp CTA = Sol line', es.html.includes('wa.me/15616988477'));
ck('unsubscribe link', es.html.includes('/api/web-leads/unsubscribe?id=abc'));
ck('identity footer', es.html.includes('info@oiikon.com'));

const en = buildWebLeadFollowupEmail({
  language: 'en', productName: null, productPrice: null, productUrl: null,
  couponCode: null, couponSavings: null,
  unsubscribeUrl: 'https://x/unsub',
});
ck('EN generic variant', en.subject.includes('left something behind') && en.html.includes('Unsubscribe'));
ck('no coupon block when none', !en.html.includes('🎁'));
ck('text fallback present', en.text.includes('Unsubscribe: https://x/unsub'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
