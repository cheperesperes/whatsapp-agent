import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

// POST /api/business/run-task  { task: "snapshot" }
//
// Lets a logged-in dashboard user trigger a daily background job ON DEMAND —
// the same jobs Vercel runs on a schedule. The cron endpoints are gated by a
// server-only CRON_SECRET that must never reach the browser, so this route is
// the safe bridge: it authenticates the USER (session cookie), then calls the
// corresponding /api/cron/* handler server-side with the secret attached.

// Allowlist: friendly key → cron path. Only these can be triggered from the UI.
const TASKS: Record<string, { path: string; label: string }> = {
  snapshot: { path: 'business-snapshot', label: 'Instantánea de negocio' },
  social: { path: 'social-stats', label: 'Engagement + gasto de Facebook' },
  marketing: { path: 'marketing-daily', label: 'Contenido de marketing' },
  followups: { path: 'send-followups', label: 'Seguimientos de WhatsApp' },
  inventory: { path: 'sync-inventory', label: 'Sincronizar inventario' },
  competitors: { path: 'competitor-stats', label: 'Estadísticas de competencia' },
};

export async function POST(req: NextRequest) {
  // Auth: require a logged-in dashboard user.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anon) {
    const sb = createServerClient(url, anon, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { task?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const task = TASKS[String(body.task ?? '')];
  if (!task) {
    return NextResponse.json(
      { error: `Tarea desconocida. Opciones: ${Object.keys(TASKS).join(', ')}` },
      { status: 400 },
    );
  }

  const secret = process.env.CRON_SECRET;
  const origin = req.nextUrl.origin;
  const started = Date.now();

  try {
    const res = await fetch(`${origin}/api/cron/${task.path}`, {
      method: 'GET',
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      cache: 'no-store',
    });
    const text = await res.text();
    let result: unknown;
    try { result = JSON.parse(text); } catch { result = text.slice(0, 500); }

    return NextResponse.json({
      ok: res.ok,
      task: body.task,
      label: task.label,
      status: res.status,
      duration_ms: Date.now() - started,
      result,
    }, { status: res.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, task: body.task, label: task.label, error: String(e) },
      { status: 500 },
    );
  }
}
