/**
 * Smoke test for lib/whatsapp.ts → parseOwnerCommand.
 * Focus is the newly added /won command (Fix #4 of the top-3-weaknesses PR)
 * but we also lock down the existing commands so nothing regresses silently.
 *
 * Run from repo root: npx tsx scripts/smoke-owner-commands.ts
 * Exit 0 on success, 1 on any failure.
 */
import { parseOwnerCommand } from '../lib/whatsapp';

let passes = 0;
let fails = 0;

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}

function expect(
  name: string,
  input: string,
  want: { command: string; args: string } | null
) {
  const got = parseOwnerCommand(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  console.log(dim('    input: ' + JSON.stringify(input)));
  console.log(dim('    want : ' + JSON.stringify(want)));
  console.log(dim('    got  : ' + JSON.stringify(got)));
  fails += 1;
}

console.log('\n/status');
expect('bare /status', '/status', { command: 'status', args: '' });
expect('/status with trailing whitespace', '  /status  ', { command: 'status', args: '' });

console.log('\n/bot');
expect('/bot +15617024893', '/bot +15617024893', { command: 'bot', args: '+15617024893' });
expect('/bot 15617024893 (no plus)', '/bot 15617024893', { command: 'bot', args: '15617024893' });
expect('/bot without number rejected', '/bot', null);

console.log('\n/teach');
expect(
  '/teach with pipe-separated pair',
  '/teach ¿Cuánto tarda el envío? | 2-4 semanas',
  { command: 'teach', args: '¿Cuánto tarda el envío? | 2-4 semanas' }
);
expect('/teach without body rejected', '/teach', null);

console.log('\n/broadcast');
expect('/broadcast with body', '/broadcast Precio especial hoy', {
  command: 'broadcast',
  args: 'Precio especial hoy',
});
expect('/broadcast without body rejected', '/broadcast', null);

console.log('\n/won (NEW)');
// Happy path: E.164 with +
expect('/won with +E164 phone', '/won +15617024893', { command: 'won', args: '+15617024893' });
// Happy path: digits only (operator convenience)
expect('/won with digits-only phone', '/won 15617024893', { command: 'won', args: '15617024893' });
// Happy path: human-formatted with parens/dashes/spaces
expect(
  '/won with human formatting',
  '/won +1 (561) 702-4893',
  { command: 'won', args: '+1 (561) 702-4893' }
);
// Cuba-format (8 digits after +53)
expect('/won with Cuba phone', '/won +5355551234', { command: 'won', args: '+5355551234' });
// Leading/trailing whitespace trimmed
expect('/won trims outer whitespace', '  /won +15617024893  ', {
  command: 'won',
  args: '+15617024893',
});
// Case-insensitive matches the other commands
expect('/won accepts /WON', '/WON +15617024893', { command: 'won', args: '+15617024893' });

// Rejection: no phone
expect('/won without phone rejected', '/won', null);
// Rejection: phone too short (under 6 digits to avoid false positives)
expect('/won with too-short phone rejected', '/won 123', null);
// Rejection: letters in phone
expect('/won with letters rejected', '/won abc1234567', null);
// Rejection: extra junk after phone
expect(
  '/won with trailing text rejected',
  '/won +15617024893 extra text here',
  null
);

console.log('\nUnrelated input');
expect('bare text is not a command', 'Hola, quiero comprar una batería', null);
expect('slash without known verb is not a command', '/pricing', null);
expect('empty string is not a command', '', null);

console.log();
if (fails === 0) {
  console.log(green(`✓ All ${passes} checks passed`));
  process.exit(0);
} else {
  console.log(red(`✗ ${fails} failed, ${passes} passed`));
  process.exit(1);
}
