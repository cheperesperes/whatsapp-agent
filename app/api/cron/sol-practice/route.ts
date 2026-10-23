import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import Anthropic from '@anthropic-ai/sdk';
import {
  createServiceClient,
  loadAgentCatalog,
  loadActiveOffers,
  loadProductCosts,
  selectBestOffer,
  hasActiveVolumeOffer,
} from '@/lib/supabase';
import { PRACTICE_SCENARIOS, playScenario, gradeScenario, type PracticeResult, type PracticeCatalogItem } from '@/lib/practice';
import { proposeLearnings, LEARNING_HARD_CONSTRAINTS, LEARNING_CATEGORIES } from '@/lib/learning';
import { REVIEW_MODEL, SOL_MODEL, claudeParams, textOf } from '@/lib/models';
import { POST as chatPOST } from '@/app/api/chat/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Nightly practice chats (Sol v2 learning loop). Simulated customers talk to
// Sol's REAL web pipeline in practice mode (no conversation/messages stored),
// replies are graded against hard rules + the live catalog, results are saved
// to sol_practice_runs, and failures become PROPOSED coaching rules that wait
// for the owner's approval on the Aprendizaje page.
//
// Auth: Vercel cron (Bearer CRON_SECRET) or a logged-in dashboard user.
// Query: ?only=id1,id2 to run a subset; ?propose=0 to skip proposals.

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return true;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anon) {
    const sb = createServerClient(url, anon, { cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} } });
    const { data: { user } } = await sb.auth.getUser();
    if (user) return true;
  }
  return false;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not set — practice mode needs it to call the chat pipeline.' }, { status: 503 });
  }

  const params = req.nextUrl.searchParams;
  const only = (params.get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const scenarios = only.length ? PRACTICE_SCENARIOS.filter((s) => only.includes(s.id)) : PRACTICE_SCENARIOS;
  const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  // Allowed prices = what the customer can actually pay today.
  const [products, offers, costs, volumeActive] = await Promise.all([
    loadAgentCatalog(),
    loadActiveOffers(),
    loadProductCosts(),
    hasActiveVolumeOffer(),
  ]);
  const catalog: PracticeCatalogItem[] = [];
  for (const p of products) {
    const disc = Math.max(0, Math.min(50, p.discount_percentage ?? 0));
    const price = Math.round((disc > 0 ? p.sell_price * (1 - disc / 100) : p.sell_price) * 100) / 100;
    catalog.push({ sku: p.sku, price, inStock: p.in_stock });
    const best = offers.length ? selectBestOffer(price, p.brand, costs[p.sku.toLowerCase()] ?? null, offers) : null;
    if (best) catalog.push({ sku: p.sku, price: best.finalPrice, inStock: p.in_stock });
  }

  const origin = req.nextUrl.origin;
  const send = async (sessionId: string, message: string, history: PracticeResult['transcript']) => {
    const chatReq = new NextRequest(new URL('/api/chat', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sol-practice': secret, origin },
      body: JSON.stringify({ sessionId, message, history }),
    });
    const res = await chatPOST(chatReq);
    const json = (await res.json()) as { reply?: string };
    return json.reply ?? '';
  };

  const results: PracticeResult[] = await mapLimit(scenarios, 4, async (s) => {
    try {
      const transcript = await playScenario(s, send, runId);
      return gradeScenario(s, transcript, catalog, offers.length > 0, volumeActive);
    } catch (err) {
      return { scenarioId: s.id, title: s.title, passed: false, failures: [{ id: 'error', desc: 'Scenario crashed' }], transcript: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  const sb = createServiceClient();
  const { error: insErr } = await sb.from('sol_practice_runs').insert(
    results.map((r) => ({
      run_id: runId,
      scenario_id: r.scenarioId,
      title: r.title,
      passed: r.passed,
      failures: r.failures,
      transcript: r.transcript,
      model: SOL_MODEL,
    })),
  );
  if (insErr) console.warn('[sol-practice] could not store results:', insErr.message);

  // Failures → proposed coaching rules (owner approves on the Aprendizaje page).
  const failed = results.filter((r) => !r.passed && !r.error);
  let proposed = 0;
  if (failed.length && params.get('propose') !== '0') {
    proposed = await proposeFromFailures(failed);
  }

  return NextResponse.json({
    run_id: runId,
    model: SOL_MODEL,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    proposed,
    stored: !insErr,
    failures: results.filter((r) => !r.passed).map((r) => ({ scenario: r.scenarioId, failed: r.failures.map((f) => f.id), error: r.error })),
  });
}

async function proposeFromFailures(failed: PracticeResult[]): Promise<number> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cases = failed
    .slice(0, 6)
    .map((r) => {
      const convo = r.transcript.map((t) => `${t.role === 'user' ? 'CLIENTE' : 'SOL'}: ${t.content.slice(0, 600)}`).join('\n');
      return `### ${r.title}\nReglas que falló: ${r.failures.map((f) => f.desc).join('; ')}\n${convo}`;
    })
    .join('\n\n');
  const prompt = `Eres el coach de ventas de Sol (asistente de WhatsApp de Oiikon). Estas son conversaciones de PRÁCTICA con clientes simulados donde Sol falló reglas verificables:

${cases}

Propón como máximo 2 directivas de coaching que corrijan la causa de fondo. Cada una: imperativa, en español, ≤ 200 caracteres, aplicable a CUALQUIER conversación (no a este cliente), sin repetir reglas obvias.

${LEARNING_HARD_CONSTRAINTS}

Categorías válidas: ${LEARNING_CATEGORIES.join(', ')}.
Devuelve SOLO JSON: { "learnings": [ { "directive": "...", "category": "...", "rationale": "qué falla corrige, en una línea" } ] }`;
  try {
    const res = await client.messages.create(
      claudeParams({ model: REVIEW_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      { timeout: 40_000 },
    );
    const text = textOf(res).trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(text) as { learnings?: { directive?: string; category?: string; rationale?: string }[] };
    return await proposeLearnings(
      (parsed.learnings ?? []).slice(0, 2).map((l) => ({
        directive: String(l.directive ?? ''),
        category: String(l.category ?? 'general'),
        rationale: `Práctica: ${String(l.rationale ?? '')}`,
      })),
      'practice',
    );
  } catch (err) {
    console.warn('[sol-practice] proposal step failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
