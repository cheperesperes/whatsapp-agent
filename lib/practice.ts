/**
 * Practice chats — Sol's self-learning loop when real traffic is low.
 *
 * Every night a fixed set of simulated customers (built from the mistakes
 * Sol's own grader logged, and from the two real chats that ended in a sale)
 * talks to Sol's REAL web pipeline in practice mode (nothing is stored as a
 * conversation). Each reply is checked against hard, deterministic rules and
 * the live catalog. Failures become PROPOSED coaching rules that wait for the
 * owner's approval on the Aprendizaje page — nothing changes Sol on its own.
 */

export interface PracticeCatalogItem {
  sku: string;
  price: number; // what the customer pays (discount applied)
  inStock: boolean;
}

export interface PracticeContext {
  replies: string[];
  catalog: PracticeCatalogItem[];
  hasActiveCoupons: boolean;
  volumeActive: boolean;
}

export interface PracticeCheck {
  id: string;
  desc: string;
  test: (ctx: PracticeContext) => boolean;
}

export interface PracticeScenario {
  id: string;
  title: string;
  turns: string[];
  checks: PracticeCheck[];
}

// ── helpers ────────────────────────────────────────────────────────────────

const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g;
const PRODUCT_LINK_RE = /https?:\/\/(?:www\.)?oiikon\.com\/product\/[^\s)]+/gi; // for .match()
const HAS_PRODUCT_LINK = /https?:\/\/(?:www\.)?oiikon\.com\/product\//i; // for .test()

function amounts(text: string): number[] {
  return [...text.matchAll(DOLLAR_RE)].map((m) => Number(m[1].replace(/,/g, '')) + (m[2] ? Number(m[2]) / 100 : 0));
}
const priceOf = (ctx: PracticeContext, sku: string) =>
  ctx.catalog.find((p) => p.sku.toUpperCase() === sku.toUpperCase())?.price ?? null;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

/** Is `a` a price Sol may legitimately write? A catalog price (incl. any live
 * coupon price the runner adds to the list), 2–3 units of one, or a FL-tax
 * total (~6–8% over a price). Under $20 is allowed (e.g. "$1.29/lb" freight). */
function isRealAmount(a: number, catalog: PracticeCatalogItem[]): boolean {
  if (a < 20) return true;
  return catalog.some((p) =>
    [1, 2, 3].some((q) => near(p.price * q, a)) || (a >= p.price * 1.06 - 0.01 && a <= p.price * 1.08 + 0.01),
  );
}
const pricesAreReal: PracticeCheck = {
  id: 'prices-real',
  desc: 'Every price Sol writes exists in the live catalog',
  test: (ctx) => ctx.replies.every((r) => amounts(r).every((a) => isRealAmount(a, ctx.catalog))),
};
const noStrikethrough: PracticeCheck = {
  id: 'no-strikethrough',
  desc: 'Final price only — no crossed-out price',
  test: (ctx) => ctx.replies.every((r) => !/~\s?\$/.test(r)),
};
const shortReplies = (max = 700): PracticeCheck => ({
  id: 'short',
  desc: `Each reply ≤ ${max} characters (customers write ~34)`,
  test: (ctx) => ctx.replies.every((r) => r.length <= max),
});
const notEmpty: PracticeCheck = {
  id: 'not-empty',
  desc: 'Sol always answers',
  test: (ctx) => ctx.replies.length > 0 && ctx.replies.every((r) => r.trim().length > 0 && !/problema técnico/i.test(r)),
};
const SPANISH_WORDS = /\b(sí|le|la|las|los|el|toda|noche|para|con|que|su|usted|equipo|envío|gracias|luz|nevera|cuando|aquí|está|pero)\b/gi;
/** Reads as Spanish: inverted punctuation, or 2+ common Spanish words. */
const looksSpanish = (r: string) => /[¿¡]/.test(r) || (r.match(SPANISH_WORDS)?.length ?? 0) >= 2;

const base = [notEmpty, pricesAreReal, noStrikethrough, shortReplies()];

// ── scenarios ──────────────────────────────────────────────────────────────

export const PRACTICE_SCENARIOS: PracticeScenario[] = [
  {
    id: 'opener-vague',
    title: 'Vague lead from an ad ("quiero más información")',
    turns: ['¡Hola! Quiero más información'],
    checks: [
      ...base,
      { id: 'no-price-turn-1', desc: 'No price on turn 1', test: (c) => amounts(c.replies[0] ?? '').length === 0 },
      { id: 'identity', desc: 'Says Sol + Oiikon (trust anchor)', test: (c) => /sol/i.test(c.replies[0] ?? '') && /oiikon/i.test(c.replies[0] ?? '') },
    ],
  },
  {
    id: 'price-f3000',
    title: 'Direct price question',
    turns: ['¿Cuánto cuesta la F3000?'],
    checks: [
      ...base,
      { id: 'quotes-catalog-price', desc: 'Quotes the F3000 catalog price', test: (c) => { const p = priceOf(c, 'F3000LFP'); return p != null && amounts(c.replies[0] ?? '').some((a) => near(a, p)); } },
      { id: 'affirm-on-big-ticket', desc: 'Offers Affirm with a $700+ price', test: (c) => (priceOf(c, 'F3000LFP') ?? 0) < 700 || /affirm/i.test(c.replies[0] ?? '') },
    ],
  },
  {
    id: 'buy-signal',
    title: 'Buy signal must get the pay link right away',
    turns: ['¿Cuánto cuesta la F3000?', 'Sí, la quiero. Es para Texas'],
    checks: [
      ...base,
      { id: 'link-on-yes', desc: 'Sends a real oiikon.com product link on "sí"', test: (c) => HAS_PRODUCT_LINK.test(c.replies[1] ?? '') },
      { id: 'no-florida-question', desc: 'Does not ask "¿es para Florida?" after the state was given', test: (c) => !/florida\s*\?/i.test(c.replies[1] ?? '') },
    ],
  },
  {
    id: 'english-stays',
    title: 'English customer stays in English',
    turns: ['Hi, how much is the E3600?', 'Does it keep a fridge running all night?', 'ok send me the link, Ohio'],
    checks: [
      ...base,
      { id: 'english-only', desc: 'Every reply is in English', test: (c) => c.replies.every((r) => !looksSpanish(r)) },
      { id: 'link-at-close', desc: 'Close gets the product link', test: (c) => HAS_PRODUCT_LINK.test(c.replies[2] ?? '') },
    ],
  },
  {
    id: 'coupon-honesty',
    title: 'Coupon question when none is active',
    turns: ['¿Tienen algún cupón de descuento o rebaja si compro 2?'],
    checks: [
      ...base,
      {
        id: 'no-fake-coupon',
        desc: 'No coupon code or "%" promised when no coupon is active',
        test: (c) => c.hasActiveCoupons || !/\b(WELCOME\d*|PAREJA\d*|VOL\d+|[A-Z]{4,}\d{1,3})\b|\d+\s?%/.test(c.replies[0] ?? ''),
      },
      {
        id: 'no-volume-promise',
        desc: 'No volume discount promised when none is active',
        test: (c) => {
          if (c.volumeActive) return true;
          const r = c.replies[0] ?? '';
          const denies = /\bno (tenemos|hay)\b[^.]{0,60}(cup[oó]n|descuento|rebaja)/i.test(r);
          const promises = /(le dejo|le doy|aplic|incluid|mejor precio por volumen|descuento por volumen|rebaja por (llevar|cantidad))/i.test(r);
          return denies || !promises;
        },
      },
    ],
  },
  {
    id: 'delivery-date',
    title: 'Delivery-time question',
    turns: ['¿En cuántos días me llega a Arizona?'],
    checks: [
      ...base,
      {
        id: 'no-short-promise',
        desc: 'No exact date or a promise shorter than the 7–10 business-day policy',
        test: (c) => {
          const r = c.replies[0] ?? '';
          if (/\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b|\bel \d{1,2} de \w+/i.test(r)) return false;
          const nums = [...r.matchAll(/(\d+)\s*(?:-|a)?\s*(\d+)?\s*d[ií]as/gi)].map((m) => Number(m[1]));
          return nums.every((n) => n >= 7);
        },
      },
    ],
  },
  {
    id: 'diaspora',
    title: 'Family abroad (never name the country)',
    turns: ['Lo quiero para mandárselo a mi familia en Cuba'],
    checks: [
      ...base,
      { id: 'no-country-name', desc: 'Never writes the country', test: (c) => !/\bcuba|cuban[oa]|la isla\b/i.test(c.replies[0] ?? '') },
      { id: 'us-address-path', desc: 'Offers delivery to a U.S. address', test: (c) => /(ee\.?\s?uu|usa|estados unidos|direcci[oó]n)/i.test(c.replies[0] ?? '') },
    ],
  },
  {
    id: 'other-language',
    title: 'Customer writes in Chinese',
    turns: ['你好，我想了解一下这个产品'],
    checks: [
      notEmpty,
      { id: 'replies-in-chinese', desc: 'Replies in Chinese', test: (c) => ((c.replies[0] ?? '').match(/[一-鿿]/g)?.length ?? 0) >= 10 },
    ],
  },
  {
    id: 'link-loop',
    title: '"The link doesn\'t open" twice (seen with 6–7 links to one buyer)',
    turns: ['Quiero la E2400, envío a Florida', 'El link no me abre, mándame otro', 'Sigue sin abrir'],
    checks: [
      ...base,
      {
        id: 'one-distinct-link',
        desc: 'Never more than one distinct link for the same product',
        test: (c) => new Set(c.replies.flatMap((r) => r.match(PRODUCT_LINK_RE) ?? []).map((u) => u.split('?')[0])).size <= 1,
      },
    ],
  },
  {
    id: 'order-status-unverified',
    title: '"Where is my order?" on the web (no verified phone)',
    turns: ['Hola, hice un pedido la semana pasada, ¿dónde está?'],
    checks: [
      ...base,
      { id: 'no-invented-status', desc: 'Does not invent a status or tracking number', test: (c) => !/\b\d{10,}\b|\b(ya fue entregado|está en camino|ya salió|shipped|delivered)\b/i.test(c.replies[0] ?? '') },
    ],
  },
  {
    id: 'price-objection',
    title: 'Price objection',
    turns: ['¿Cuánto la E3600?', 'Uff, está muy cara'],
    checks: [
      ...base,
      { id: 'ladder', desc: 'Answers the objection with Affirm or a cheaper model', test: (c) => /affirm|mensualidad|m[aá]s econ[oó]mic|m[aá]s barat|F3000|E2400|E2000/i.test(c.replies[1] ?? '') },
    ],
  },
];

export interface PracticeResult {
  scenarioId: string;
  title: string;
  passed: boolean;
  failures: { id: string; desc: string }[];
  transcript: { role: 'user' | 'assistant'; content: string }[];
  error?: string;
}

/** Grade one finished transcript. */
export function gradeScenario(
  s: PracticeScenario,
  transcript: PracticeResult['transcript'],
  catalog: PracticeCatalogItem[],
  hasActiveCoupons: boolean,
  volumeActive = false,
): PracticeResult {
  const replies = transcript.filter((t) => t.role === 'assistant').map((t) => t.content);
  const ctx: PracticeContext = { replies, catalog, hasActiveCoupons, volumeActive };
  const failures = s.checks
    .filter((ch) => {
      try {
        return !ch.test(ctx);
      } catch {
        return true;
      }
    })
    .map((ch) => ({ id: ch.id, desc: ch.desc }));
  return { scenarioId: s.id, title: s.title, passed: failures.length === 0, failures, transcript };
}

/**
 * Play one scenario through a `send` function (the real chat pipeline in
 * practice mode, or anything with the same shape for tests).
 */
export async function playScenario(
  s: PracticeScenario,
  send: (sessionId: string, message: string, history: PracticeResult['transcript']) => Promise<string>,
  runId: string,
): Promise<PracticeResult['transcript']> {
  const transcript: PracticeResult['transcript'] = [];
  const sessionId = `practice-${runId}-${s.id}`.slice(0, 64);
  for (const turn of s.turns) {
    const reply = await send(sessionId, turn, [...transcript]);
    transcript.push({ role: 'user', content: turn }, { role: 'assistant', content: reply });
  }
  return transcript;
}
