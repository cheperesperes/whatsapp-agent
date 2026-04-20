/**
 * Smoke test for the customer-read v1 memory loop.
 * Covers:
 *   • mergeReading — the "null preserves existing" merge rule, objection_themes
 *     union/cap, arrival_source preservation across turns
 *   • formatReadingForPrompt — block rendering, empty-input short-circuit,
 *     per-dimension guidance, internal-only disclaimer
 *
 * Run from worktree root: npx tsx scripts/smoke-customer-read.ts
 * Exits 0 on success, 1 on any failure.
 */
import { mergeReading } from '../lib/anthropic';
import { formatReadingForPrompt } from '../lib/supabase';
import type { CustomerProfileReading } from '../lib/types';

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

const NOW = '2026-04-20T12:00:00.000Z';

// ============================================================
// mergeReading — "null preserves existing" rule
// ============================================================

check(
  'empty existing + empty fresh → only last_updated_at populated',
  mergeReading(null, {}, NOW),
  { last_updated_at: NOW }
);

check(
  'fresh value writes when existing is null',
  mergeReading(null, { intent_stage: 'evaluando' }, NOW),
  { intent_stage: 'evaluando', last_updated_at: NOW }
);

check(
  'fresh null DOES NOT clobber existing intent_stage',
  mergeReading(
    { intent_stage: 'listo_comprar' } as CustomerProfileReading,
    { intent_stage: null },
    NOW
  ),
  { intent_stage: 'listo_comprar', last_updated_at: NOW }
);

check(
  'fresh undefined DOES NOT clobber existing',
  mergeReading(
    { knowledge_level: 'experto' } as CustomerProfileReading,
    {}, // knowledge_level not emitted at all
    NOW
  ),
  { knowledge_level: 'experto', last_updated_at: NOW }
);

check(
  'confident fresh value overrides existing',
  mergeReading(
    { intent_stage: 'explorando' } as CustomerProfileReading,
    { intent_stage: 'listo_comprar' },
    NOW
  ),
  { intent_stage: 'listo_comprar', last_updated_at: NOW }
);

check(
  'all four enum dimensions merge independently',
  mergeReading(
    {
      intent_stage: 'explorando',
      knowledge_level: 'novato',
      price_sensitivity: 'media',
      urgency: 'meses',
    } as CustomerProfileReading,
    {
      intent_stage: 'evaluando', // new
      knowledge_level: null, // preserved
      price_sensitivity: 'alta', // new
      urgency: null, // preserved
    },
    NOW
  ),
  {
    intent_stage: 'evaluando',
    knowledge_level: 'novato',
    price_sensitivity: 'alta',
    urgency: 'meses',
    last_updated_at: NOW,
  }
);

// ── objection_themes: union + cap at 6 + dedup ───────────────────

check(
  'objection_themes: empty fresh array is a no-op (does NOT clear existing)',
  mergeReading(
    { objection_themes: ['precio', 'envío'] } as CustomerProfileReading,
    { objection_themes: [] },
    NOW
  ),
  { objection_themes: ['precio', 'envío'], last_updated_at: NOW }
);

check(
  'objection_themes: unions with existing',
  mergeReading(
    { objection_themes: ['precio'] } as CustomerProfileReading,
    { objection_themes: ['envío', 'confianza'] },
    NOW
  ),
  {
    objection_themes: ['precio', 'envío', 'confianza'],
    last_updated_at: NOW,
  }
);

check(
  'objection_themes: dedups on merge',
  mergeReading(
    { objection_themes: ['precio', 'envío'] } as CustomerProfileReading,
    { objection_themes: ['envío', 'confianza'] },
    NOW
  ),
  {
    objection_themes: ['precio', 'envío', 'confianza'],
    last_updated_at: NOW,
  }
);

check(
  'objection_themes: caps at 6 (keeps most recent)',
  mergeReading(
    {
      objection_themes: ['a1', 'a2', 'a3', 'a4'],
    } as CustomerProfileReading,
    {
      objection_themes: ['a5', 'a6', 'a7', 'a8'],
    },
    NOW
  ),
  { objection_themes: ['a3', 'a4', 'a5', 'a6', 'a7', 'a8'], last_updated_at: NOW }
);

check(
  'objection_themes: normalizes (trim + lowercase)',
  mergeReading(
    null,
    { objection_themes: ['  PRECIO  ', 'Envío'] },
    NOW
  ),
  { objection_themes: ['precio', 'envío'], last_updated_at: NOW }
);

// ── arrival_source: the turn-1 seed lives here forever ───────────

check(
  'arrival_source survives a later Haiku merge that does not emit it',
  mergeReading(
    {
      arrival_source: 'facebook_ad:fb_products_es',
      intent_stage: 'explorando',
    } as CustomerProfileReading,
    { intent_stage: 'evaluando' }, // Haiku never touches arrival_source
    NOW
  ),
  {
    arrival_source: 'facebook_ad:fb_products_es',
    intent_stage: 'evaluando',
    last_updated_at: NOW,
  }
);

check(
  'arrival_source seeded on turn 1 from null profile',
  mergeReading(
    null,
    { arrival_source: 'facebook_ad:fb_info_en' },
    NOW
  ),
  {
    arrival_source: 'facebook_ad:fb_info_en',
    last_updated_at: NOW,
  }
);

check(
  'arrival_source can be overwritten (should not happen in practice, but supported)',
  mergeReading(
    { arrival_source: 'organic' } as CustomerProfileReading,
    { arrival_source: 'facebook_ad:fb_info_es' },
    NOW
  ),
  {
    arrival_source: 'facebook_ad:fb_info_es',
    last_updated_at: NOW,
  }
);

// ── last_updated_at: always stamped ─────────────────────────────

check(
  'last_updated_at is always set to the passed `now`',
  mergeReading(
    { intent_stage: 'evaluando', last_updated_at: '2020-01-01T00:00:00.000Z' } as CustomerProfileReading,
    {},
    NOW
  ),
  { intent_stage: 'evaluando', last_updated_at: NOW }
);

// ============================================================
// formatReadingForPrompt — prompt-block rendering
// ============================================================

check('null reading → empty string', formatReadingForPrompt(null), '');
check(
  'empty object (only last_updated_at) → empty string',
  formatReadingForPrompt({ last_updated_at: NOW } as CustomerProfileReading),
  ''
);

const singleDimBlock = formatReadingForPrompt({
  intent_stage: 'listo_comprar',
  last_updated_at: NOW,
} as CustomerProfileReading);

checkTrue(
  'single dimension: header is present',
  singleDimBlock.includes('=== CÓMO LEER A ESTE CLIENTE')
);
checkTrue(
  'single dimension: internal-only disclaimer is present',
  singleDimBlock.includes('NO se la muestres')
);
checkTrue(
  'single dimension: renders the stage line',
  singleDimBlock.includes('Etapa: listo_comprar')
);
checkTrue(
  'single dimension: includes prescriptive action for listo_comprar',
  singleDimBlock.toLowerCase().includes('link') &&
    singleDimBlock.toLowerCase().includes('no re-vendas')
);
checkTrue(
  'single dimension: does NOT render unpopulated dimensions',
  !singleDimBlock.includes('Nivel técnico:') &&
    !singleDimBlock.includes('Urgencia:') &&
    !singleDimBlock.includes('Origen:')
);

// All five enum stages render a hint ──────────────────────────
for (const stage of ['explorando', 'evaluando', 'listo_comprar', 'post_venta'] as const) {
  const b = formatReadingForPrompt({
    intent_stage: stage,
    last_updated_at: NOW,
  } as CustomerProfileReading);
  checkTrue(
    `intent_stage=${stage} gets a non-trivial hint`,
    b.includes(`Etapa: ${stage} — `) && b.length > 80
  );
}

for (const lvl of ['novato', 'intermedio', 'experto'] as const) {
  const b = formatReadingForPrompt({
    knowledge_level: lvl,
    last_updated_at: NOW,
  } as CustomerProfileReading);
  checkTrue(
    `knowledge_level=${lvl} gets a non-trivial hint`,
    b.includes(`Nivel técnico: ${lvl} — `) && b.length > 80
  );
}

for (const ps of ['alta', 'media', 'baja'] as const) {
  const b = formatReadingForPrompt({
    price_sensitivity: ps,
    last_updated_at: NOW,
  } as CustomerProfileReading);
  checkTrue(
    `price_sensitivity=${ps} gets a non-trivial hint`,
    b.includes(`Sensibilidad a precio: ${ps} — `) && b.length > 80
  );
}

for (const u of ['ya', 'semanas', 'meses', 'sin_prisa'] as const) {
  const b = formatReadingForPrompt({
    urgency: u,
    last_updated_at: NOW,
  } as CustomerProfileReading);
  checkTrue(
    `urgency=${u} gets a non-trivial hint`,
    b.includes(`Urgencia: ${u} — `) && b.length > 80
  );
}

// objection_themes rendering ──────────────────────────────────
const withObjections = formatReadingForPrompt({
  objection_themes: ['precio', 'envío'],
  last_updated_at: NOW,
} as CustomerProfileReading);
checkTrue(
  'objection_themes: rendered as comma-joined list',
  withObjections.includes('Objeciones vistas: precio, envío')
);
checkTrue(
  'objection_themes: includes imperative to address them',
  withObjections.includes('adelántate')
);

// Empty objection_themes array does NOT produce a line
const emptyObjections = formatReadingForPrompt({
  objection_themes: [],
  last_updated_at: NOW,
} as CustomerProfileReading);
check(
  'objection_themes empty array → no block at all (nothing else populated)',
  emptyObjections,
  ''
);

// arrival_source rendering ────────────────────────────────────
const adArrival = formatReadingForPrompt({
  arrival_source: 'facebook_ad:fb_info_es',
  last_updated_at: NOW,
} as CustomerProfileReading);
checkTrue(
  'arrival_source ad: shows the source and an ad-specific hint',
  adArrival.includes('Origen: facebook_ad:fb_info_es') &&
    adArrival.toLowerCase().includes('anuncio de facebook')
);

const organicArrival = formatReadingForPrompt({
  arrival_source: 'organic',
  last_updated_at: NOW,
} as CustomerProfileReading);
checkTrue(
  'arrival_source organic: shows the source and an organic hint',
  organicArrival.includes('Origen: organic') &&
    organicArrival.toLowerCase().includes('orgánicamente')
);

// Full block with all dimensions ───────────────────────────────
const full = formatReadingForPrompt({
  intent_stage: 'evaluando',
  knowledge_level: 'intermedio',
  price_sensitivity: 'alta',
  urgency: 'semanas',
  objection_themes: ['precio', 'envío'],
  arrival_source: 'facebook_ad:fb_products_es',
  last_updated_at: NOW,
} as CustomerProfileReading);

checkTrue('full block: has header', full.includes('=== CÓMO LEER A ESTE CLIENTE'));
checkTrue('full block: has Etapa line', full.includes('Etapa: evaluando'));
checkTrue('full block: has Nivel técnico line', full.includes('Nivel técnico: intermedio'));
checkTrue(
  'full block: has Sensibilidad a precio line',
  full.includes('Sensibilidad a precio: alta')
);
checkTrue('full block: has Urgencia line', full.includes('Urgencia: semanas'));
checkTrue('full block: has Objeciones vistas line', full.includes('Objeciones vistas: precio, envío'));
checkTrue('full block: has Origen line', full.includes('Origen: facebook_ad:fb_products_es'));

// ── Guardrail: block never contains WhatsApp-breaking markdown ─
// The WhatsApp format normalizer is a safety net, but this block lands in
// the system prompt (internal guidance) — if it ever leaks into an answer
// AND contains `**bold**` or tables, the customer sees literal asterisks.
checkTrue('prompt block: no **', !/\*\*/.test(full));
checkTrue('prompt block: no ~~', !/~~/.test(full));
checkTrue('prompt block: no | table separators', !full.includes('|'));

// ============================================================
// Summary
// ============================================================

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
