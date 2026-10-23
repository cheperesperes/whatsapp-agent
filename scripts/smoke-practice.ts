/**
 * Smoke test for lib/practice.ts graders — run with: npx tsx scripts/smoke-practice.ts
 * Replies below are REAL Sol replies from the 2026-10-23 preview runs (before
 * and after the fixes), so the graders are checked against actual behavior.
 */
import { PRACTICE_SCENARIOS, gradeScenario, type PracticeCatalogItem } from '../lib/practice';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const catalog: PracticeCatalogItem[] = [
  { sku: 'F3000LFP', price: 899, inStock: true },
  { sku: 'E3600LFP', price: 999, inStock: true },
  { sku: 'E2400LFP', price: 649, inStock: true },
];
const sc = (id: string) => PRACTICE_SCENARIOS.find((s) => s.id === id)!;
const t = (...pairs: string[]) => pairs.map((c, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: c }));

const beforeFix = 'Si lleva 2 unidades, le dejo el mejor precio por volumen que tengamos, ya aplicado en su link de pago. El descuento varía según el modelo.';
const afterFix = 'Honestamente, ahora mismo no tenemos cupón activo ni descuento por llevar 2 unidades, así que cada equipo sale al precio de catálogo.';
check('catches the real volume-discount promise (before fix)', !gradeScenario(sc('coupon-honesty'), t('¿cupón si compro 2?', beforeFix), catalog, false, false).passed);
check('passes the honest answer (after fix)', gradeScenario(sc('coupon-honesty'), t('¿cupón si compro 2?', afterFix), catalog, false, false).passed);

const price = '¡Claro! La PECRON F3000LFP cuesta *$899.00 USD*, con envío gratis a todo USA 🙌\n\n👉 https://oiikon.com/product/pecron-f3000lfp\n\nY si prefiere no pagarlo todo de una vez, en el checkout puede dividirlo en mensualidades con Affirm.';
check('real price reply passes', gradeScenario(sc('price-f3000'), t('¿Cuánto cuesta la F3000?', price), catalog, false).passed);
check('invented price fails', !gradeScenario(sc('price-f3000'), t('¿Cuánto cuesta la F3000?', price.replace('$899.00', '$799.00')), catalog, false).passed);
check('crossed-out price fails', !gradeScenario(sc('price-f3000'), t('¿Cuánto cuesta la F3000?', '~$1,049.00~ *$899.00 USD* con Affirm'), catalog, false).passed);

const buy = '¡Perfecto, a Texas va con envío gratis! Aquí tiene su link de pago seguro 👇\n\n💳 Pago seguro:\nhttps://oiikon.com/product/pecron-f3000lfp';
check('buy reply with link passes', gradeScenario(sc('buy-signal'), t('¿Cuánto cuesta la F3000?', price, 'Sí, la quiero. Es para Texas', buy), catalog, false).passed);
check('Sep 30 "kit listo 👇" with no link fails', !gradeScenario(sc('buy-signal'), t('¿Cuánto?', price, 'si', '¡Perfecto! Le dejo su kit listo 👇 Pago seguro con tarjeta — cero riesgo 😊'), catalog, false).passed);

check('Spanish in an English chat fails', !gradeScenario(sc('english-stays'), t('Hi', 'The E3600LFP is $999', 'fridge?', 'Sí, le dura toda la noche', 'link', 'https://oiikon.com/product/pecron-e3600lfp'), catalog, false).passed);
check('"entre el 11 y 13 de junio" fails delivery check', !gradeScenario(sc('delivery-date'), t('¿cuándo llega?', 'Estaría llegando entre el 11 y 13 de junio, 3–5 días hábiles.'), catalog, false).passed);
check('"7-10 días hábiles" passes delivery check', gradeScenario(sc('delivery-date'), t('¿cuándo llega?', 'Lo enviamos lo antes posible; como referencia, alrededor de 7-10 días hábiles.'), catalog, false).passed);
check('naming the country fails', !gradeScenario(sc('diaspora'), t('para Cuba', 'Entregamos en EE.UU.; para Cuba use una agencia.'), catalog, false).passed);
check('two different links fail the loop check', !gradeScenario(sc('link-loop'), t('a', 'https://oiikon.com/product/pecron-e2400lfp', 'b', 'https://oiikon.com/product/pecron-e2400lfp-v2', 'c', 'ok'), catalog, false).passed);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
