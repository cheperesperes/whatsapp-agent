/**
 * Smoke test for lib/anthropic.ts — parseLeadScoreResponse (mocked, no API key).
 * Run: npx tsx scripts/smoke-lead-quality.ts
 */
import { parseLeadScoreResponse } from '../lib/anthropic';

let pass = 0,
  fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\n▶ parseLeadScoreResponse()');

const r1 = parseLeadScoreResponse(
  '{"quality":"hot","reason":"Customer asked for payment link","recommended_action":"Send link"}'
);
check('hot parses', r1?.quality === 'hot');
check('reason captured', r1?.reason === 'Customer asked for payment link');

const r2 = parseLeadScoreResponse(
  '```json\n{"quality":"warm","reason":"Engaged, no commit","recommended_action":"Follow up tomorrow"}\n```'
);
check('strips ```json fences', r2?.quality === 'warm');

const r3 = parseLeadScoreResponse('{"quality":"sizzling","reason":"x","recommended_action":"y"}');
check('invalid quality defaults to cold', r3?.quality === 'cold');

const r4 = parseLeadScoreResponse('not json');
check('garbage returns null', r4 === null);

const r5 = parseLeadScoreResponse('{"quality":"dead"}');
check('missing reason → empty string', r5?.quality === 'dead' && r5?.reason === '');

const longReason = 'x'.repeat(500);
const r6 = parseLeadScoreResponse(JSON.stringify({ quality: 'warm', reason: longReason }));
check('reason clamped to 200', r6?.reason.length === 200);

const r7 = parseLeadScoreResponse(JSON.stringify({ quality: 'cold', recommended_action: 'a'.repeat(400) }));
check('recommended_action clamped to 200', r7?.recommended_action.length === 200);

console.log('\n' + '═'.repeat(50));
if (fail === 0) {
  console.log(`✓ ALL ${pass} CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`✗ ${fail} FAILED, ${pass} passed`);
  process.exit(1);
}
