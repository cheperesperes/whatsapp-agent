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

// ── detectLanguage: French + Haitian Creole (PROD case 2026-06-10) ──
// Jean Pierre (+509, Haiti) asked "Le prix ?" four times and got Spanish
// every time — "le" hit the Spanish stopword list. These mirror his real
// messages verbatim.

check('PROD fr: Bonjour ! Puis-je en savoir plus à ce sujet ?',
  detectLanguage('Bonjour ! Puis-je en savoir plus à ce sujet ?'), 'fr');
check('PROD fr: Le prix ? (le collides with es — prix must win)',
  detectLanguage('Le prix ?'), 'fr');
check('PROD fr: 7500 watts le prix ? (en+es+fr tokens — fr wins)',
  detectLanguage('7500 watts le prix ?'), 'fr');
check('PROD fr/es mix: Necesita una panneau solaire portative',
  detectLanguage('Necesita una panneau solaire portative'), 'fr');
check('fr diacritic only: ça coûte combien', detectLanguage('ça coûte combien'), 'fr');
check('ht: Bonjou, konbyen pri a?', detectLanguage('Bonjou, konbyen pri a?'), 'ht');
check('ht: Mwen vle achte yon estasyon', detectLanguage('Mwen vle achte yon estasyon'), 'ht');
check('ht beats fr diacritic: èske ou gen kouran',
  detectLanguage('èske ou gen kouran'), 'ht');

// Guards: existing es/en behavior unchanged by the new languages.
check('guard: hola gracias still es', detectLanguage('hola gracias'), 'es');
check('guard: how much still en', detectLanguage('Hi, how much is this?'), 'en');

check('history: French thread → fr',
  detectLanguageFromHistory(['Bonjour !', 'Le prix ?']), 'fr');
check('history: unknown with persisted fr → fr',
  detectLanguageFromHistory(['E1000LFP'], 'fr'), 'fr');

checkTrue('lock fr: contains FRANÇAIS',
  formatLanguageLockForPrompt('fr').includes('FRANÇAIS'));
checkTrue('lock fr: keeps links untranslated',
  formatLanguageLockForPrompt('fr').includes('liens'));
checkTrue('lock ht: contains KREYÒL',
  formatLanguageLockForPrompt('ht').includes('KREYÒL'));
checkTrue('lock ht: forbids es/en replies',
  formatLanguageLockForPrompt('ht').includes('PA JANM'));

// ── Summary ───────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
