/**
 * Smoke test for lib/human-voice.ts + follow-up rotation — run with:
 *   npx tsx scripts/smoke-human-voice.ts
 * Cases mirror real chats (e.g. the 2026-06-18 post-sale thread where Sol
 * answered every "👍" and "gracias" in a row).
 */
import { isBareCloser, shouldStaySilentOnCloser } from '../lib/human-voice';
import { buildFollowupDraft, buildQuoteNudgeDraft } from '../lib/followup';
import type { Message } from '../lib/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}`); }
}
const chat = (...turns: [Message['role'], string][]): Message[] =>
  turns.map(([role, content], i) => ({ id: String(i), conversation_id: 'c', role, content, handoff_detected: false, created_at: '' }) as Message);

check('"gracias" is a closer', isBareCloser('Gracias'));
check('"ok 👍" is a closer', isBareCloser('ok 👍'));
check('"👍🙏" is a closer', isBareCloser('👍🙏'));
check('"cuánto cuesta" is not', !isBareCloser('cuánto cuesta'));
check('"listo, mándame el link" is not', !isBareCloser('listo, mándame el link'));

check('thumbs-up after a statement → silent',
  shouldStaySilentOnCloser(chat(['assistant', 'Que lo disfrute mucho en su traila 🙏'], ['user', '👍'])));
check('"ok" after a question → reply (it is an answer)',
  !shouldStaySilentOnCloser(chat(['assistant', '¿Se lo dejo listo?'], ['user', 'Ok'])));
check('first "gracias" after an answer → reply once',
  !shouldStaySilentOnCloser(chat(['assistant', 'Su número de rastreo es 8728…'], ['user', 'Gracias'])));
check('"gracias" after Sol already said goodbye → silent',
  shouldStaySilentOnCloser(chat(['assistant', '¡Con gusto! Que tenga un excelente día.'], ['user', 'Gracias'])));
check('second closer in a row → silent',
  shouldStaySilentOnCloser(chat(['user', 'Gracias'], ['assistant', '¡Con mucho gusto, Jorge!'], ['user', 'Muchas gracias'])));
check('first contact "ok" → reply',
  !shouldStaySilentOnCloser(chat(['user', 'Ok'])));

const quote = 'El *PECRON F3000LFP* — 👉 https://oiikon.com/product/pecron-f3000lfp';
const es = new Set([0, 1, 2, 3, 4].map((v) => buildFollowupDraft({ customerName: 'Ana', lastAssistantContent: quote, language: 'es', variant: v })));
const en = new Set([0, 1, 2, 3, 4].map((v) => buildQuoteNudgeDraft({ customerName: 'Ana', lastAssistantContent: quote, language: 'en', variant: v })));
check('5 distinct Spanish follow-ups', es.size === 5);
check('5 distinct English quote nudges', en.size === 5);
check('no follow-up uses the old repeated opener', [...es].every((s) => !/quería ver si pudo revisar/i.test(s)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
