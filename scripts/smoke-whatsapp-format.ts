/**
 * Smoke test for lib/whatsapp-format.ts.
 * Cases taken directly from production violations on 2026-04-20.
 * Exits 0 on success, 1 on any failure.
 *
 * Run from worktree root: npx tsx scripts/smoke-whatsapp-format.ts
 */
import { normalizeWhatsAppFormatting } from '../lib/whatsapp-format';
import type { FormatFixCode } from '../lib/whatsapp-format';

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

function check(
  name: string,
  got: { text: string; fixes: FormatFixCode[] },
  wantText: string,
  wantFixes: FormatFixCode[]
) {
  const textOk = got.text === wantText;
  const fixesOk =
    got.fixes.length === wantFixes.length &&
    wantFixes.every((f) => got.fixes.includes(f));
  if (textOk && fixesOk) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  if (!textOk) {
    console.log(dim('    want text: ' + JSON.stringify(wantText)));
    console.log(dim('    got  text: ' + JSON.stringify(got.text)));
  }
  if (!fixesOk) {
    console.log(dim('    want fixes: ' + JSON.stringify(wantFixes)));
    console.log(dim('    got  fixes: ' + JSON.stringify(got.fixes)));
  }
  fails += 1;
}

// ── Production cases ──────────────────────────────────────────────

// Real message from +584126905438 at 17:20 ET on 2026-04-20
check(
  'prod: E1000LFP reply with two double-asterisk spans',
  normalizeWhatsAppFormatting(
    'The *PECRON E1000LFP* has **1,024Wh** of stored energy — and the inverter handles up to **1,800W**, so it can start a fridge without issues.'
  ),
  'The *PECRON E1000LFP* has *1,024Wh* of stored energy — and the inverter handles up to *1,800W*, so it can start a fridge without issues.',
  ['double_asterisk']
);

// Real message at 01:34 ET (last night) with Markdown table
check(
  'prod: EcoFlow vs PECRON comparison table detected',
  normalizeWhatsAppFormatting(
    '¡Claro, Kikon! Aquí la comparación directa:\n\n*EcoFlow DELTA 2* vs *PECRON E1500LFP*\n\n| | EcoFlow DELTA 2 | PECRON E1500LFP |\n|---|---|---|\n| Capacidad | 1,024 Wh | 1,536 Wh |\n| Potencia | 1,800W | 2,200W |'
  ),
  '¡Claro, Kikon! Aquí la comparación directa:\n\n*EcoFlow DELTA 2* vs *PECRON E1500LFP*\n\n| | EcoFlow DELTA 2 | PECRON E1500LFP |\n|---|---|---|\n| Capacidad | 1,024 Wh | 1,536 Wh |\n| Potencia | 1,800W | 2,200W |',
  ['markdown_table_detected']
);

// ── Happy path ────────────────────────────────────────────────────

check(
  'happy: clean WhatsApp text is unchanged',
  normalizeWhatsAppFormatting(
    '*PECRON E500LFP* — *$189.00* · envío gratis en USA\n→ *$231.00 entregado en Cuba*\n👉 https://oiikon.com/product/pecron-e500lfp'
  ),
  '*PECRON E500LFP* — *$189.00* · envío gratis en USA\n→ *$231.00 entregado en Cuba*\n👉 https://oiikon.com/product/pecron-e500lfp',
  []
);

check(
  'happy: empty string passes through',
  normalizeWhatsAppFormatting(''),
  '',
  []
);

// ── Edge cases ────────────────────────────────────────────────────

check(
  'edge: multiple double-asterisk spans across lines',
  normalizeWhatsAppFormatting('Line one **bold** here.\nLine two **also bold** there.'),
  'Line one *bold* here.\nLine two *also bold* there.',
  ['double_asterisk']
);

check(
  'edge: double tilde strikethrough (discount pattern)',
  normalizeWhatsAppFormatting(
    '~~$299~~ **$199** 🔥 33% de descuento'
  ),
  '~$299~ *$199* 🔥 33% de descuento',
  ['double_asterisk', 'double_tilde']
);

check(
  'edge: pipe characters without separator row do NOT trigger table detection',
  normalizeWhatsAppFormatting(
    'El E1000LFP tiene 1024Wh | 1800W output | $332.10 USD — todo en un equipo.'
  ),
  'El E1000LFP tiene 1024Wh | 1800W output | $332.10 USD — todo en un equipo.',
  []
);

check(
  'edge: asterisk between words (single star) unchanged',
  normalizeWhatsAppFormatting('El *PECRON* es la mejor opción.'),
  'El *PECRON* es la mejor opción.',
  []
);

check(
  'edge: double asterisk with price + emoji unicode',
  normalizeWhatsAppFormatting('💰 **$332.10** · envío gratis'),
  '💰 *$332.10* · envío gratis',
  ['double_asterisk']
);

check(
  'edge: markdown table with colon-aligned separator',
  normalizeWhatsAppFormatting(
    '| Spec | A | B |\n|:---|:---:|---:|\n| Watts | 1800 | 2200 |'
  ),
  '| Spec | A | B |\n|:---|:---:|---:|\n| Watts | 1800 | 2200 |',
  ['markdown_table_detected']
);

check(
  'edge: both double-asterisk AND table detected in same message',
  normalizeWhatsAppFormatting(
    'Comparativa **rápida**:\n\n| Spec | A | B |\n|---|---|---|\n| Watts | **1800** | 2200 |'
  ),
  'Comparativa *rápida*:\n\n| Spec | A | B |\n|---|---|---|\n| Watts | *1800* | 2200 |',
  ['double_asterisk', 'markdown_table_detected']
);

// ── Summary ───────────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
