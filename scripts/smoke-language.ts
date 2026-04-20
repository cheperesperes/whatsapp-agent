/**
 * Smoke test for lib/language.ts.
 * Verifies pure detection + history aggregation + lock builder.
 * Cases drawn from production violations on 2026-04-20.
 * Exits 0 on success, 1 on any failure.
 *
 * Run from worktree root: npx tsx scripts/smoke-language.ts
 */
import {
  detectLanguage,
  detectLanguageFromHistory,
  formatLanguageLockForPrompt,
} from '../lib/language';

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

// ── detectLanguage: strong Spanish signals ──────────────────────

check('diacritic: mañana', detectLanguage('mañana'), 'es');
check('diacritic: ¿cuánto?', detectLanguage('¿cuánto?'), 'es');
check('diacritic: información', detectLanguage('información'), 'es');
check('inverted exclamation: ¡hola!', detectLanguage('¡hola!'), 'es');

// ── detectLanguage: Spanish stopwords ──────────────────────────

check('pure Spanish — precio', detectLanguage('cual es el precio'), 'es');
check('pure Spanish — necesito', detectLanguage('necesito algo para apagones'), 'es');
check('pure Spanish — hola gracias', detectLanguage('hola gracias'), 'es');

// ── detectLanguage: pure English ───────────────────────────────

check('pure English — how much', detectLanguage('Hi, how much is this?'), 'en');
check('pure English — shipping cost', detectLanguage('what is the shipping cost'), 'en');
check('pure English — thanks', detectLanguage('thanks, that works'), 'en');
check('pure English contraction', detectLanguage("I don't know"), 'en');

// ── detectLanguage: Spanglish (production case) ────────────────

check(
  'PROD: Hello + Spanish body → es',
  detectLanguage('Hello! Que capacidad tiene esa Pecron E1000 LFP?'),
  'es'
);
check(
  'Spanglish: ok gracias → es',
  detectLanguage('ok gracias'),
  'es'
);
check(
  'Spanglish: OK precio → es',
  detectLanguage('OK cual es el precio'),
  'es'
);
check(
  'Spanglish: Hi amigo, cuanto cuesta? → es',
  detectLanguage('Hi amigo, cuanto cuesta?'),
  'es'
);
check(
  'Spanglish inverse: ok thanks → en (no Spanish token)',
  detectLanguage('ok thanks'),
  'en'
);

// ── detectLanguage: unknown / ambiguous ────────────────────────

check('empty string', detectLanguage(''), 'unknown');
check('whitespace only', detectLanguage('   '), 'unknown');
check('SKU only', detectLanguage('E1000LFP'), 'unknown');
check('numbers only', detectLanguage('1234'), 'unknown');
check('emoji only', detectLanguage('🔥💪'), 'unknown');

// ── detectLanguageFromHistory: aggregation + fallback ──────────

check(
  'history: one Spanglish msg → es',
  detectLanguageFromHistory(['Hello! Que capacidad tiene esa Pecron E1000 LFP?']),
  'es'
);
check(
  'history: all English → en',
  detectLanguageFromHistory(['Hi there', 'How much is it?', 'Thanks']),
  'en'
);
check(
  'history: empty → default es',
  detectLanguageFromHistory([]),
  'es'
);
check(
  'history: unknown SKU-only with persisted en → en',
  detectLanguageFromHistory(['E1000LFP'], 'en'),
  'en'
);
check(
  'history: unknown with persisted es → es',
  detectLanguageFromHistory(['E1000LFP'], 'es'),
  'es'
);
check(
  'history: unknown with no persisted → default es',
  detectLanguageFromHistory(['E1000LFP'], null),
  'es'
);
check(
  'history: prior English, current SKU → still en (aggregated)',
  detectLanguageFromHistory(['Hi, how are you?', 'What is the price?', 'E1000']),
  'en'
);
check(
  'history: prior Spanish, current English word → still es (aggregated)',
  detectLanguageFromHistory(['hola, necesito una estacion', 'para apagones', 'thanks']),
  'es'
);

// ── formatLanguageLockForPrompt: content checks ────────────────

checkTrue(
  'lock es: contains RESPONDE EN ESPAÑOL',
  formatLanguageLockForPrompt('es').includes('RESPONDE EN ESPAÑOL')
);
checkTrue(
  'lock es: explicitly mentions English loan-words',
  formatLanguageLockForPrompt('es').toLowerCase().includes('hello') &&
    formatLanguageLockForPrompt('es').toLowerCase().includes('thanks')
);
checkTrue(
  'lock es: claims priority over other instructions',
  formatLanguageLockForPrompt('es').includes('prioridad')
);
checkTrue(
  'lock en: contains RESPOND IN ENGLISH',
  formatLanguageLockForPrompt('en').includes('RESPOND IN ENGLISH')
);
checkTrue(
  'lock en: forbids mid-reply switch',
  formatLanguageLockForPrompt('en').toLowerCase().includes('never switch')
);

// ── Summary ───────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
