// Smoke test for the web widget formatter — run with: node scripts/smoke-widget-format.js public/widget.js
const src = require('fs').readFileSync(process.argv[2], 'utf8');
const pick = (name) => { const i = src.indexOf('  function ' + name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
eval(pick('escapeHtml') + '\n' + pick('formatText') + '\nglobalThis.formatText = formatText;');
const cases = [
  ['link clickable', '👉 https://oiikon.com/product/pecron-f3000lfp', (o) => o.includes('<a href="https://oiikon.com/product/pecron-f3000lfp"') && o.includes('target="_blank"')],
  ['promo link with ? & = kept', 'https://oiikon.com/product/pecron-e3600lfp?promo=SAVE5&qty=2', (o) => /href="https:\/\/oiikon\.com\/product\/pecron-e3600lfp\?promo=SAVE5&amp;qty=2"/.test(o)],
  ['trailing period not in link', 'Visite https://oiikon.com/faq.', (o) => o.includes('href="https://oiikon.com/faq"') && o.endsWith('</a>.')],
  ['underscore slug not italicized', 'https://oiikon.com/product/kit_hogar_2400', (o) => o.includes('kit_hogar_2400') && !o.includes('<em>')],
  ['**bold** renders clean', 'Tap **Buy** now', (o) => o === 'Tap <strong>Buy</strong> now'],
  ['*bold* renders clean', 'La *F3000* cuesta', (o) => o === 'La <strong>F3000</strong> cuesta'],
  ['_italic_ word', 'es _muy_ bueno', (o) => o === 'es <em>muy</em> bueno'],
  ['HTML injection escaped', '<img src=x onerror=alert(1)>', (o) => !o.includes('<img') && o.includes('&lt;img')],
  ['javascript: url not linked', 'javascript:alert(1)', (o) => !o.includes('<a ')],
  ['quote break-out blocked', 'https://evil.com/"onmouseover="alert(1)', (o) => !/href="[^"]*"onmouseover/.test(o)],
  ['newlines', 'a\nb', (o) => o === 'a<br>b'],
];
let pass = 0; for (const [n, input, ok] of cases) { const o = formatText(input); const r = ok(o); if (r) pass++; console.log((r ? '✅ ' : '❌ ') + n + (r ? '' : '  →  ' + o)); }
console.log(`\n${pass}/${cases.length} passed`); if (pass !== cases.length) process.exitCode = 1;
