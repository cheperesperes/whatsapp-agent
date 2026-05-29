#!/usr/bin/env node
/**
 * Composite deterministic spec + offer badges onto a clean marketing image.
 * AI image models can't render text reliably, so we overlay it ourselves.
 *
 * Usage:
 *   node scripts/marketing-offer-overlay.mjs <imageUrlOrPath> <out.png> '<json>'
 * where <json> = {"spec":"5120Wh · 7200W · LiFePO4","was":"$1,999",
 *                 "now":"$1,899","save":"AHORRA $100","code":"FAMILIA_F5000",
 *                 "cta":"oiikon.com · wa.me/15616988477"}
 */
import sharp from 'sharp';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const [src, out = 'offer.png', jsonArg] = process.argv.slice(2);
const o = jsonArg ? JSON.parse(jsonArg) : {
  spec: '5120Wh · 7200W · LiFePO4',
  was: '$1,999', now: '$1,899', save: 'AHORRA $100',
  code: 'FAMILIA_F5000', cta: 'oiikon.com · wa.me/15616988477',
};

const buf = existsSync(src)
  ? readFileSync(src)
  : Buffer.from(await (await fetch(src)).arrayBuffer());

const img = sharp(buf);
const { width: W, height: H } = await img.metadata();
const F = 'Helvetica, Arial, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// rough text-width estimate for the spec pill
const specW = o.spec.length * 17 + 56;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </linearGradient></defs>
  <rect x="0" y="0" width="${W}" height="${Math.round(H * 0.34)}" fill="url(#g)"/>

  <!-- spec pill -->
  <rect x="40" y="44" rx="26" ry="26" width="${specW}" height="56" fill="#0b8a4a"/>
  <text x="${40 + 28}" y="82" font-family="${F}" font-size="30" font-weight="700" fill="#fff">${esc(o.spec)}</text>

  <!-- price -->
  <text x="44" y="178" font-family="${F}" font-size="42" fill="#fff" opacity="0.85">${esc(o.was)}</text>
  <line x1="44" y1="164" x2="${44 + o.was.length * 23}" y2="164" stroke="#fff" stroke-width="4" opacity="0.85"/>
  <text x="${64 + o.was.length * 23}" y="190" font-family="${F}" font-size="92" font-weight="800" fill="#ffd400">${esc(o.now)}</text>

  <!-- save pill + code -->
  <rect x="44" y="216" rx="16" width="${o.save.length * 19 + 40}" height="52" fill="#e23b2e"/>
  <text x="64" y="252" font-family="${F}" font-size="30" font-weight="800" fill="#fff">${esc(o.save)}</text>
  <text x="44" y="312" font-family="${F}" font-size="30" font-weight="700" fill="#fff">Código: ${esc(o.code)}</text>

  <!-- CTA bottom -->
  <rect x="0" y="${H - 86}" width="${W}" height="86" fill="#000" opacity="0.45"/>
  <text x="44" y="${H - 32}" font-family="${F}" font-size="34" font-weight="700" fill="#fff">${esc(o.cta)}</text>
</svg>`;

const result = await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
writeFileSync(out, result);
console.log(`wrote ${out} (${W}x${H})`);
