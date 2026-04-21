/**
 * Smoke test for the per-turn dynamic-directive layer.
 * Covers:
 *   • hasRejectionSignal — the Spanish rejection patterns list.
 *   • buildDynamicDirectives — soft-close mandate (fires when intent_stage
 *     is 'listo_comprar' AND user has spoken ≥3 times), post-no pivot
 *     (fires when the latest user text contains a rejection signal), and
 *     the combined case.
 *
 * Run from repo root: npx tsx scripts/smoke-dynamic-directives.ts
 * Exits 0 on success, 1 on any failure.
 */
import { buildDynamicDirectives, hasRejectionSignal } from '../lib/anthropic';

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

function checkTrue(name: string, got: boolean) {
  if (got) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  fails += 1;
}

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  console.log(dim('    want: ' + JSON.stringify(want)));
  console.log(dim('    got:  ' + JSON.stringify(got)));
  fails += 1;
}

// ────────────────────────────────────────────────────────────
// hasRejectionSignal — exact coverage of the REJECTION_PATTERNS list.
// The prompt rules are Spanish-only; English is handled by language
// detection upstream (language locks Sol into EN replies, pivot applies
// regardless of surface language once reading drops into `objection_themes`).
// ────────────────────────────────────────────────────────────

console.log('hasRejectionSignal (matches):');
const rejectionTrue = [
  'no me interesa',
  'No me interesa gracias',
  'NO ME INTERESA',
  'no estoy interesado',
  'no estoy interesada',
  'está muy caro',
  'es muy costoso',
  'demasiado caro para mí',
  'está fuera de mi presupuesto',
  'no tengo presupuesto',
  'no tengo ese presupuesto',
  'no puedo pagarlo',
  'no puedo pagar eso',
  'no me alcanza',
  'mejor después',
  'mejor despues', // accent-less variant
  'mejor más adelante',
  'mejor mas adelante',
  'ya no quiero nada',
];
for (const s of rejectionTrue) {
  checkTrue(`matches "${s}"`, hasRejectionSignal(s));
}

console.log('\nhasRejectionSignal (non-matches):');
const rejectionFalse = [
  '¿Cuánto cuesta la E1500LFP?',
  'Me interesa el modelo de 1500Wh',
  'Quiero saber más',
  'dime el link',
  '¿Tienen descuento?',
  'Perfecto, envíamelo',
  '',
  'precio',
  // Null-safe: the function must not throw on missing input
  null as unknown as string,
  undefined as unknown as string,
];
for (const s of rejectionFalse) {
  checkTrue(
    `does NOT flag ${JSON.stringify(s)}`,
    !hasRejectionSignal(s)
  );
}

// ────────────────────────────────────────────────────────────
// buildDynamicDirectives — empty when neither rule fires
// ────────────────────────────────────────────────────────────

console.log('\nbuildDynamicDirectives:');
check(
  'empty string when no signals',
  buildDynamicDirectives({
    userTurnCount: 1,
    intentStage: 'explorando',
    lastUserText: '¿qué tienen?',
  }),
  ''
);

check(
  'empty when intent_stage undefined and no rejection',
  buildDynamicDirectives({
    userTurnCount: 4,
    lastUserText: 'gracias',
  }),
  ''
);

// ────────────────────────────────────────────────────────────
// Soft-close: listo_comprar + user turn ≥ 3
// ────────────────────────────────────────────────────────────

const softClose3 = buildDynamicDirectives({
  userTurnCount: 3,
  intentStage: 'listo_comprar',
  lastUserText: 'dame el link',
});
checkTrue(
  'soft-close fires at turn 3 when listo_comprar',
  softClose3.length > 0
);
checkTrue(
  'soft-close mentions "CIERRE SUAVE"',
  softClose3.includes('CIERRE SUAVE')
);
checkTrue(
  'soft-close block has the DIRECTIVAS header',
  softClose3.includes('DIRECTIVAS DINÁMICAS')
);

const softClose5 = buildDynamicDirectives({
  userTurnCount: 5,
  intentStage: 'listo_comprar',
  lastUserText: 'ok',
});
checkTrue(
  'soft-close fires at turn 5 when listo_comprar',
  softClose5.includes('CIERRE SUAVE')
);

// Below threshold
const softCloseTurn1 = buildDynamicDirectives({
  userTurnCount: 1,
  intentStage: 'listo_comprar',
  lastUserText: 'hola',
});
check('soft-close does NOT fire at turn 1', softCloseTurn1, '');

const softCloseTurn2 = buildDynamicDirectives({
  userTurnCount: 2,
  intentStage: 'listo_comprar',
  lastUserText: 'ok me interesa',
});
check('soft-close does NOT fire at turn 2', softCloseTurn2, '');

// Wrong stage → no soft-close
for (const stage of ['explorando', 'evaluando', 'post_venta'] as const) {
  const block = buildDynamicDirectives({
    userTurnCount: 5,
    intentStage: stage,
    lastUserText: '¿cuánto?',
  });
  check(`soft-close does NOT fire for intent_stage=${stage}`, block, '');
}

// ────────────────────────────────────────────────────────────
// Post-rejection pivot
// ────────────────────────────────────────────────────────────

const pivot = buildDynamicDirectives({
  userTurnCount: 2,
  intentStage: 'evaluando',
  lastUserText: 'está muy caro para mi',
});
checkTrue('pivot fires on "muy caro"', pivot.includes('PIVOTE'));
checkTrue('pivot block has the DIRECTIVAS header', pivot.includes('DIRECTIVAS DINÁMICAS'));

const pivot2 = buildDynamicDirectives({
  userTurnCount: 1,
  intentStage: 'explorando',
  lastUserText: 'no me interesa, gracias',
});
checkTrue('pivot fires on "no me interesa"', pivot2.includes('PIVOTE'));

const pivot3 = buildDynamicDirectives({
  userTurnCount: 2,
  intentStage: undefined,
  lastUserText: 'no tengo presupuesto ahora',
});
checkTrue('pivot fires even when intent_stage is undefined', pivot3.includes('PIVOTE'));

// ────────────────────────────────────────────────────────────
// Both rules at once (listo_comprar at turn 3 AND rejection signal)
// ────────────────────────────────────────────────────────────

const both = buildDynamicDirectives({
  userTurnCount: 4,
  intentStage: 'listo_comprar',
  lastUserText: 'mejor después, está muy caro',
});
checkTrue('combined case fires BOTH rules (soft-close + pivot)',
  both.includes('CIERRE SUAVE') && both.includes('PIVOTE')
);
checkTrue('combined block has exactly one DIRECTIVAS header (deduped)',
  both.split('DIRECTIVAS DINÁMICAS').length === 2
);

// ────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
