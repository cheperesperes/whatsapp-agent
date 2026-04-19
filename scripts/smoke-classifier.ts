/**
 * Smoke test for lib/classifier.ts — mocked (no API key needed).
 * Verifies pure helpers: lastAssistantHadRecommendation, parseClassifierResponse,
 * formatIntentHintForPrompt. Exits 0 on success, 1 on any failure.
 *
 * Run from worktree root: npx tsx scripts/smoke-classifier.ts
 */
import {
  lastAssistantHadRecommendation,
  parseClassifierResponse,
  formatIntentHintForPrompt,
  type IntentClassification,
  type IntentStage,
} from '../lib/classifier';
import type { Message } from '../lib/types';

let passes = 0;
let fails = 0;

function pass(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function fail(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passes++;
    console.log(`  ${pass('✓')} ${name}${detail ? dim(' — ' + detail) : ''}`);
  } else {
    fails++;
    console.log(`  ${fail('✗')} ${name}${detail ? ' — ' + fail(detail) : ''}`);
  }
}

function msg(role: 'user' | 'assistant', content: string): Message {
  return {
    id: 'x',
    conversation_id: 'x',
    role,
    content,
    handoff_detected: false,
    created_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n▶ Group 1: lastAssistantHadRecommendation()');
// ─────────────────────────────────────────────────────────────────────

check(
  'empty history → false',
  lastAssistantHadRecommendation([]) === false
);

check(
  'assistant message without product link → false',
  lastAssistantHadRecommendation([
    msg('assistant', '¿Qué aparatos necesita?'),
  ]) === false
);

check(
  'assistant with oiikon product link → true',
  lastAssistantHadRecommendation([
    msg(
      'assistant',
      'Le recomiendo el E1500LFP. 👉 https://oiikon.com/product/pecron-e1500lfp'
    ),
  ]) === true
);

check(
  'oiikon link but in older turn (last assistant is plain) → false',
  lastAssistantHadRecommendation([
    msg('assistant', 'https://oiikon.com/product/pecron-e500lfp'),
    msg('user', 'me parece caro'),
    msg('assistant', '¿Cuánto presupuesto tiene?'),
  ]) === false
);

check(
  'http (not https) link still detected → true',
  lastAssistantHadRecommendation([
    msg('assistant', 'http://oiikon.com/product/pecron-e1500lfp'),
  ]) === true
);

check(
  'unrelated link does NOT count as rec → false',
  lastAssistantHadRecommendation([
    msg('assistant', 'visite https://wikipedia.org/wiki/Solar_panel'),
  ]) === false
);

check(
  'last user message ignored even if it has a link → false',
  lastAssistantHadRecommendation([
    msg('assistant', '¿Qué aparatos?'),
    msg('user', 'vi este: https://oiikon.com/product/pecron-e500lfp'),
  ]) === false
);

// ─────────────────────────────────────────────────────────────────────
console.log('\n▶ Group 2: parseClassifierResponse()');
// ─────────────────────────────────────────────────────────────────────

const validJson = JSON.stringify({
  stage: 'equipment_listed',
  prior_assistant_recommended: false,
  equipment_mentioned: ['Nevera', 'TV', '  Ventilador  ', '', 'luces LED'],
  destination_hint: 'cuba',
  language: 'es',
  needs_handoff: false,
  notes: 'Customer enumerated equipment for 4 rooms.',
});

const r1 = parseClassifierResponse(validJson, false);
check('parses valid JSON → not null', r1 !== null);
check('stage = equipment_listed', r1?.stage === 'equipment_listed');
check(
  'equipment lowercased + trimmed + empty filtered',
  JSON.stringify(r1?.equipment_mentioned) ===
    JSON.stringify(['nevera', 'tv', 'ventilador', 'luces led'])
);
check('destination_hint = cuba', r1?.destination_hint === 'cuba');
check('language = es', r1?.language === 'es');
check('notes preserved', r1?.notes?.includes('enumerated') === true);

const fenced = '```json\n' + validJson + '\n```';
const r2 = parseClassifierResponse(fenced, false);
check('strips ```json fences', r2?.stage === 'equipment_listed');

const garbage = parseClassifierResponse('not json at all', false);
check('returns null on unparseable input', garbage === null);

const partial = parseClassifierResponse(JSON.stringify({}), true);
check(
  'missing fields → defaults stage to discovery_open',
  partial?.stage === 'discovery_open'
);
check(
  'missing prior_assistant_recommended → uses fallback (true)',
  partial?.prior_assistant_recommended === true
);
check('missing equipment → empty array', partial?.equipment_mentioned.length === 0);
check('missing language → defaults es', partial?.language === 'es');
check('missing destination → null', partial?.destination_hint === null);

const withHandoff = parseClassifierResponse(
  JSON.stringify({ needs_handoff: true, stage: 'objection' }),
  false
);
check('needs_handoff = true preserved', withHandoff?.needs_handoff === true);

const longNotes = parseClassifierResponse(
  JSON.stringify({ notes: 'a'.repeat(500) }),
  false
);
check('notes clamped to 280 chars', longNotes?.notes.length === 280);

const tooMuchEquipment = parseClassifierResponse(
  JSON.stringify({
    equipment_mentioned: Array.from({ length: 20 }, (_, i) => `item${i}`),
  }),
  false
);
check(
  'equipment clamped to 12 items',
  tooMuchEquipment?.equipment_mentioned.length === 12
);

const badDestination = parseClassifierResponse(
  JSON.stringify({ destination_hint: 'mars' }),
  false
);
check(
  'invalid destination → null (not "mars")',
  badDestination?.destination_hint === null
);

// ─────────────────────────────────────────────────────────────────────
console.log('\n▶ Group 3: formatIntentHintForPrompt()');
// ─────────────────────────────────────────────────────────────────────

check('null intent → empty string', formatIntentHintForPrompt(null) === '');

const allStages: IntentStage[] = [
  'greeting',
  'discovery_open',
  'equipment_listed',
  'price_asked',
  'ready_to_buy',
  'objection',
  'logistics',
  'vague_followup',
  'off_topic',
];

for (const stage of allStages) {
  const intent: IntentClassification = {
    stage,
    prior_assistant_recommended: false,
    equipment_mentioned: [],
    destination_hint: null,
    language: 'es',
    needs_handoff: false,
    notes: '',
  };
  const out = formatIntentHintForPrompt(intent);
  check(
    `stage="${stage}" renders with non-empty guidance`,
    out.includes(`Etapa detectada: ${stage}`) &&
      out.includes('Guía para esta etapa:') &&
      !out.includes('Guía para esta etapa: \n')
  );
}

// Critical: when prior_assistant_recommended=true, the hint must FORBID more questions.
const postRec: IntentClassification = {
  stage: 'vague_followup',
  prior_assistant_recommended: true,
  equipment_mentioned: ['nevera', 'tv'],
  destination_hint: 'cuba',
  language: 'es',
  needs_handoff: false,
  notes: 'Customer answered vaguely after Sol recommended.',
};
const postRecHint = formatIntentHintForPrompt(postRec);
check(
  'prior_rec=true → hint contains "PROHIBIDO" (blocks discovery questions)',
  postRecHint.includes('PROHIBIDO')
);
check(
  'prior_rec=true → hint mentions allowed close phrasings',
  postRecHint.includes('¿Lo ordenamos?')
);
check(
  'equipment list rendered comma-separated',
  postRecHint.includes('nevera, tv')
);
check('destination=cuba rendered', postRecHint.includes('Destino del envío: cuba'));

// Verify the bug-case full hint
console.log('\n  ' + dim('--- Sample hint for the bug case (post-recommendation, vague answer) ---'));
console.log(dim(postRecHint.split('\n').map((l) => '  ' + l).join('\n')));

// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
const total = passes + fails;
if (fails === 0) {
  console.log(pass(`✓ ALL ${passes}/${total} CHECKS PASSED`));
  process.exit(0);
} else {
  console.log(fail(`✗ ${fails} FAILED, ${passes} passed (of ${total})`));
  process.exit(1);
}
