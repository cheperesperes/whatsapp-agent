/** Smoke test for language resolution — run with: npx tsx scripts/smoke-language.ts */
import { resolveLanguage, detectScriptLanguageName } from '../lib/language';
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
check('Chinese → generic Chinese lock (was Spanish)', resolveLanguage(['你好，我想了解一下这个产品']).lock.includes('RESPOND ENTIRELY IN Chinese'));
check('Japanese detected', detectScriptLanguageName('こんにちは、この製品について知りたいです') === 'Japanese');
check('Korean detected', detectScriptLanguageName('안녕하세요 제품 문의') === 'Korean');
check('Arabic detected', detectScriptLanguageName('مرحبا أريد معرفة السعر') === 'Arabic');
check('Russian detected', detectScriptLanguageName('Здравствуйте, сколько стоит?') === 'Russian');
check('Chinese + model name still Chinese', detectScriptLanguageName('F3000LFP 多少钱？') === 'Chinese');
check('Spanish stays Spanish', resolveLanguage(['¿Cuánto cuesta la F3000?']).lock.includes('RESPONDE EN ESPAÑOL'));
check('English stays English', resolveLanguage(['Hi, how much is the E3600?']).lock.includes('RESPOND IN ENGLISH'));
check('emoji-only falls back normally', resolveLanguage(['👍'], 'en').lock.includes('RESPOND IN ENGLISH'));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
