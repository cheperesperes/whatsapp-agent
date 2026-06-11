/** Smoke for the deferred-bug fixes: batch folding + link-priority hint. */
import { parseMetaIncomingMessage } from '../lib/whatsapp-meta';
import { deriveKnownProductHint } from '../lib/anthropic';
import type { Message } from '../lib/types';

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

const mkBody = (msgs: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID' }, contacts: [{ profile: { name: 'Test' } }], messages: msgs } }] }],
});

// 1. Same-sender double-text folds into extraTexts.
const p1 = parseMetaIncomingMessage(mkBody([
  { from: '15551234567', id: 'wamid.1', timestamp: '1', type: 'text', text: { body: 'Hola' } },
  { from: '15551234567', id: 'wamid.2', timestamp: '2', type: 'text', text: { body: '¿Cuánto cuesta el F5000?' } },
]));
ck('batch: primary text', p1?.messageText === 'Hola');
ck('batch: extra folded', p1?.extraTexts.length === 1 && p1?.extraTexts[0].includes('F5000'));
ck('batch: nothing dropped', p1?.droppedBatchMessages === 0);

// 2. Cross-sender / non-text extras counted as dropped.
const p2 = parseMetaIncomingMessage(mkBody([
  { from: '15551234567', id: 'wamid.3', timestamp: '1', type: 'text', text: { body: 'Hola' } },
  { from: '19998887777', id: 'wamid.4', timestamp: '2', type: 'text', text: { body: 'otro' } },
  { from: '15551234567', id: 'wamid.5', timestamp: '3', type: 'image' },
]));
ck('batch: cross-sender + non-text dropped=2', p2?.droppedBatchMessages === 2 && p2?.extraTexts.length === 0);

// 3. Single message unchanged.
const p3 = parseMetaIncomingMessage(mkBody([
  { from: '15551234567', id: 'wamid.6', timestamp: '1', type: 'text', text: { body: 'solo' } },
]));
ck('batch: single message clean', p3?.extraTexts.length === 0 && p3?.droppedBatchMessages === 0);

// 4. Hint: link SKU beats a passing body mention of another model.
const msg = (content: string): Message =>
  ({ id: '', conversation_id: '', role: 'assistant', content, handoff_detected: false, created_at: '' } as Message);
const h1 = deriveKnownProductHint({
  history: [msg('A diferencia del E1000, el *E3600LFP* aguanta 2 días.\n👉 https://oiikon.com/product/pecron-e3600lfp')],
});
ck('hint: link SKU wins over passing mention', h1 === 'E3600LFP');

// 5. Hint: multi-link menu → no single rec (falls to ad/interest).
const h2 = deriveKnownProductHint({
  history: [msg('Opciones:\n👉 https://oiikon.com/product/pecron-e2000lfp\n👉 https://oiikon.com/product/pecron-e3600lfp')],
  productInterest: 'F5000LFP',
});
ck('hint: menu falls through to product_interest', h2 === 'F5000LFP');

// 6. Hint: body-only single SKU still works (no link present).
const h3 = deriveKnownProductHint({ history: [msg('El *E2400LFP* le cubre la noche completa.')] });
ck('hint: body-only single SKU', h3 === 'E2400LFP');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
