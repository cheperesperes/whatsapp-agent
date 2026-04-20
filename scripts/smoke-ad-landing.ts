/**
 * Smoke test for lib/ad-landing.ts.
 * Verifies opener detection (positive + negative) and directive builders.
 * Exits 0 on success, 1 on any failure.
 *
 * Run from worktree root: npx tsx scripts/smoke-ad-landing.ts
 */
import {
  detectAdOpener,
  normalizeForOpenerMatch,
  formatAdArrivalDirective,
  formatFirstContactDirective,
  buildFirstContactDirective,
} from '../lib/ad-landing';

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

function checkTrue(name: string, got: boolean) {
  check(name, got, true);
}

// ── normalizeForOpenerMatch ────────────────────────────────────

check('strip diacritics', normalizeForOpenerMatch('¿Qué Productos Ofrecen?'), 'que productos ofrecen');
check('typographic quotes', normalizeForOpenerMatch('"Hola"'), 'hola');
check('trailing emoji', normalizeForOpenerMatch('¡Hola! 😊'), 'hola');
check('inverted Spanish punctuation', normalizeForOpenerMatch('¡Hola! Quiero más información'), 'hola quiero mas informacion');
check('collapse internal whitespace', normalizeForOpenerMatch('  more     info  '), 'more info');
check('leading/trailing space', normalizeForOpenerMatch('   hello   '), 'hello');
check('empty returns empty', normalizeForOpenerMatch(''), '');
check('period and comma removed', normalizeForOpenerMatch('Hello, can I get more info on this.'), 'hello can i get more info on this');

// ── detectAdOpener: the three operator-confirmed FB templates ─

check(
  'exact FB template: "¿Qué productos ofrecen?"',
  detectAdOpener('¿Qué productos ofrecen?'),
  { variant: 'fb_products_es', language: 'es' }
);
check(
  'exact FB template: "Hello! Can I get more info on this?"',
  detectAdOpener('Hello! Can I get more info on this?'),
  { variant: 'fb_info_en', language: 'en' }
);
check(
  'exact FB template: "¡Hola! Quiero más información"',
  detectAdOpener('¡Hola! Quiero más información'),
  { variant: 'fb_info_es', language: 'es' }
);

// ── detectAdOpener: normalization tolerance ────────────────────

checkTrue(
  'ALL CAPS variant still matches',
  detectAdOpener('QUE PRODUCTOS OFRECEN')?.variant === 'fb_products_es'
);
checkTrue(
  'no accents still matches',
  detectAdOpener('Hola quiero mas informacion')?.variant === 'fb_info_es'
);
checkTrue(
  'trailing whitespace still matches',
  detectAdOpener('  hello  ')?.variant === 'fb_greet_en'
);
checkTrue(
  'emoji-suffixed greeting matches',
  detectAdOpener('Hola 👋')?.variant === 'fb_greet_es'
);
checkTrue(
  'abbreviated "mas info" matches',
  detectAdOpener('mas info')?.variant === 'fb_info_es'
);

// ── detectAdOpener: language detection ─────────────────────────

check(
  'EN greeting flagged as English',
  detectAdOpener('Hi')?.language,
  'en'
);
check(
  'ES greeting flagged as Spanish',
  detectAdOpener('Buenas tardes')?.language,
  'es'
);

// ── detectAdOpener: NEGATIVE cases (real questions must NOT match) ──

check(
  'real question is NOT an opener: "cuanto cuesta el E1500LFP?"',
  detectAdOpener('cuanto cuesta el E1500LFP?'),
  null
);
check(
  'real question is NOT an opener: "¿Qué inversor me recomiendan para 2000W?"',
  detectAdOpener('¿Qué inversor me recomiendan para 2000W?'),
  null
);
check(
  'real question is NOT an opener: "Hello, I want to buy the DELTA 2"',
  detectAdOpener('Hello, I want to buy the DELTA 2'),
  null
);
check(
  'modified template is NOT an opener: "Hola quiero info de paneles solares"',
  detectAdOpener('Hola quiero info de paneles solares'),
  null
);
check(
  'length guard: long message never matches',
  detectAdOpener(
    'Hola buenas tardes estoy interesado en comprar un sistema completo de energia solar'
  ),
  null
);
check('empty string returns null', detectAdOpener(''), null);
check('whitespace-only returns null', detectAdOpener('   '), null);

// ── formatAdArrivalDirective ───────────────────────────────────

const esDirective = formatAdArrivalDirective({
  variant: 'fb_info_es',
  language: 'es',
});
checkTrue('ES ad directive labels it Turn 1', esDirective.includes('TURNO 1'));
checkTrue('ES ad directive says ad arrival', esDirective.toLowerCase().includes('ad de facebook'));
checkTrue('ES ad directive has one qualifier', esDirective.includes('UNA sola pregunta'));
checkTrue(
  'ES ad directive forbids listing products',
  esDirective.includes('NO DEBE') && esDirective.toLowerCase().includes('productos')
);
checkTrue(
  'ES ad directive forbids SEND_IMAGE',
  esDirective.includes('[SEND_IMAGE:')
);
checkTrue(
  'ES ad directive includes Cuba-vs-here example',
  esDirective.toLowerCase().includes('cuba')
);

const enDirective = formatAdArrivalDirective({
  variant: 'fb_info_en',
  language: 'en',
});
checkTrue('EN ad directive labels it Turn 1', enDirective.includes('TURN 1'));
checkTrue('EN ad directive says ad arrival', enDirective.toLowerCase().includes('facebook ad'));
checkTrue('EN ad directive has one qualifier', enDirective.includes('ONE qualifying question'));
checkTrue(
  'EN ad directive forbids listing products',
  enDirective.toLowerCase().includes('must not') && enDirective.toLowerCase().includes('products')
);
checkTrue(
  'EN ad directive forbids SEND_IMAGE',
  enDirective.includes('[SEND_IMAGE:')
);

// ── formatFirstContactDirective (organic turn 1) ───────────────

const esFirst = formatFirstContactDirective('es');
const enFirst = formatFirstContactDirective('en');
checkTrue('ES organic directive mentions Turno 1', esFirst.includes('TURNO 1'));
checkTrue('ES organic directive mentions Sol presentation', esFirst.includes('Sol de Oiikon'));
checkTrue('EN organic directive mentions Turn 1', enFirst.includes('TURN 1'));
checkTrue('EN organic directive introduces Sol', enFirst.includes('Sol from Oiikon'));

// ── buildFirstContactDirective: the webhook integration ────────

const built1 = buildFirstContactDirective('¿Qué productos ofrecen?', 'es');
checkTrue('ad-detected → adMatch is not null', built1?.adMatch?.variant === 'fb_products_es');
checkTrue(
  'ad-detected → directive is the Spanish ad arrival block',
  built1?.directive.includes('TURNO 1 · LLEGÓ') ?? false
);

const built2 = buildFirstContactDirective('cuanto cuesta el E1500?', 'es');
checkTrue('real question → adMatch is null', built2?.adMatch === null);
checkTrue(
  'real question → directive is the organic-first-contact block (ES)',
  built2?.directive.includes('TURNO 1 · CLIENTE NUEVO') ?? false
);

const built3 = buildFirstContactDirective('How much is the DELTA 2?', 'en');
checkTrue('real EN question → adMatch is null', built3?.adMatch === null);
checkTrue(
  'real EN question → directive is the organic-first-contact block (EN)',
  built3?.directive.includes('TURN 1 · NEW CUSTOMER') ?? false
);

check(
  'empty message → null',
  buildFirstContactDirective('', 'es'),
  null
);
check(
  'whitespace-only message → null',
  buildFirstContactDirective('   ', 'es'),
  null
);

// ── Guardrail: directives never contain markdown formatting ───
// The Phase-1 WhatsApp format normalizer is a safety net, but the directive
// text lands in the system prompt (not a customer message). Still: if a
// future edit accidentally uses `**bold**` or tables, the model may echo
// them. Catch that before it hits production.
checkTrue('ES ad directive: no **', !/\*\*/.test(esDirective));
checkTrue('ES ad directive: no ~~', !/~~/.test(esDirective));
checkTrue('EN ad directive: no **', !/\*\*/.test(enDirective));
checkTrue('EN ad directive: no ~~', !/~~/.test(enDirective));
checkTrue('ES organic directive: no **', !/\*\*/.test(esFirst));
checkTrue('EN organic directive: no **', !/\*\*/.test(enFirst));

// ── Summary ───────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
