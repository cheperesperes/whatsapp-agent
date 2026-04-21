/**
 * Smoke test for lib/followup.ts.
 * Verifies pure draft builder + model extraction + detection patterns.
 * Exits 0 on success, 1 on any failure.
 *
 * Run from worktree root: npx tsx scripts/smoke-followup.ts
 */
import {
  buildFollowupDraft,
  extractProductModel,
  formatFirstName,
  hasPriorFollowup,
  FOLLOWUP_MARKER_PATTERNS,
} from '../lib/followup';

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

function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
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

function checkTrue(name: string, got: boolean) {
  check(name, got, true);
}

// ── extractProductModel ────────────────────────────────────────

check('PECRON E1500LFP', extractProductModel('te recomiendo el PECRON E1500LFP por $469'), 'E1500LFP');
check('E3600LFP bare', extractProductModel('E3600LFP cubre toda la casa'), 'E3600LFP');
check('F3000LFP', extractProductModel('F3000LFP'), 'F3000LFP');
check('E500LFP', extractProductModel('E500LFP es el más pequeño'), 'E500LFP');
check('DELTA 2 Max', extractProductModel('EcoFlow DELTA 2 Max'), 'DELTA 2');
check('no model → null', extractProductModel('hola, gracias'), null);
check('empty → null', extractProductModel(''), null);

// ── formatFirstName ────────────────────────────────────────────

check('Carlos Pérez → Carlos', formatFirstName('Carlos Pérez'), 'Carlos');
check('CARLOS → Carlos', formatFirstName('CARLOS'), 'Carlos');
check('carlos → Carlos', formatFirstName('carlos'), 'Carlos');
check('  Juan  → Juan', formatFirstName('  Juan  '), 'Juan');
check('null → empty', formatFirstName(null), '');
check('undefined → empty', formatFirstName(undefined), '');
check('empty → empty', formatFirstName(''), '');
check('Maria José González → Maria', formatFirstName('Maria José González'), 'Maria');

// ── buildFollowupDraft: Spanish ────────────────────────────────

const esWithModelAndName = buildFollowupDraft({
  customerName: 'Carlos Pérez',
  lastAssistantContent:
    'Le recomiendo el E1500LFP — https://oiikon.com/product/pecron-e1500lfp',
  language: 'es',
});
checkTrue('ES+name+model: starts with Hola Carlos,', esWithModelAndName.startsWith('Hola Carlos, '));
checkTrue('ES+name+model: contains E1500LFP', esWithModelAndName.includes('E1500LFP'));
checkTrue('ES+name+model: has template phrase', esWithModelAndName.includes('quería ver si pudo revisar'));
checkTrue('ES+name+model: has closing question', esWithModelAndName.includes('¿Alguna duda'));
checkTrue(
  'ES+name+model: triggers followup detector',
  FOLLOWUP_MARKER_PATTERNS.some((p) => p.test(esWithModelAndName))
);

const esNoName = buildFollowupDraft({
  customerName: null,
  lastAssistantContent: 'Le recomiendo el E1500LFP',
  language: 'es',
});
checkTrue('ES no-name: starts with Hola,', esNoName.startsWith('Hola, '));
checkTrue('ES no-name: still has model', esNoName.includes('E1500LFP'));

const esNoModel = buildFollowupDraft({
  customerName: 'Ana',
  lastAssistantContent: 'Gracias por su interés, aquí más info sobre productos.',
  language: 'es',
});
checkTrue('ES no-model: falls back to vague phrase', esNoModel.includes('lo que le compartí'));
checkTrue('ES no-model: still greets Ana', esNoModel.startsWith('Hola Ana, '));

// ── buildFollowupDraft: English ────────────────────────────────

const enWithModelAndName = buildFollowupDraft({
  customerName: 'Carlos',
  lastAssistantContent: 'I recommend the E1500LFP — https://oiikon.com/product/pecron-e1500lfp',
  language: 'en',
});
checkTrue('EN+name+model: starts with Hi Carlos,', enWithModelAndName.startsWith('Hi Carlos, '));
checkTrue('EN+name+model: has template phrase', enWithModelAndName.includes('just checking in on'));
checkTrue('EN+name+model: has E1500LFP', enWithModelAndName.includes('E1500LFP'));
checkTrue('EN+name+model: has closing question', enWithModelAndName.includes('Any questions'));
checkTrue(
  'EN+name+model: triggers followup detector',
  FOLLOWUP_MARKER_PATTERNS.some((p) => p.test(enWithModelAndName))
);

const enNoName = buildFollowupDraft({
  customerName: null,
  lastAssistantContent: 'The DELTA 2 is great for your needs',
  language: 'en',
});
checkTrue('EN no-name: starts with Hi,', enNoName.startsWith('Hi, '));
checkTrue('EN no-name: extracts DELTA 2', enNoName.includes('DELTA 2'));

// ── hasPriorFollowup ──────────────────────────────────────────

checkTrue(
  'prior followup detected in ES message',
  hasPriorFollowup([
    { content: 'Hola Carlos, quería ver si pudo revisar el E1500LFP' },
  ])
);
checkTrue(
  'prior followup detected in EN message',
  hasPriorFollowup([
    { content: 'Hi Carlos, just checking in on the E1500LFP' },
  ])
);
check(
  'no prior followup: clean history',
  hasPriorFollowup([
    { content: 'Hola, aquí tiene el link para ordenar' },
    { content: 'Le recomiendo el E1500LFP' },
  ]),
  false
);
check(
  'no prior followup: empty',
  hasPriorFollowup([]),
  false
);

// ── Guardrail: drafts never contain `**` / `~~` / markdown tables ──
// Hand-rolled check to avoid a cross-branch dependency on lib/whatsapp-format.ts.
// If any future template change accidentally uses Markdown-style formatting,
// this catches it before it hits production.
check('ES draft: no double-asterisk', /\*\*/.test(esWithModelAndName), false);
check('ES draft: no double-tilde', /~~/.test(esWithModelAndName), false);
check('EN draft: no double-asterisk', /\*\*/.test(enWithModelAndName), false);
check('EN draft: no double-tilde', /~~/.test(enWithModelAndName), false);

// ── Summary ───────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
