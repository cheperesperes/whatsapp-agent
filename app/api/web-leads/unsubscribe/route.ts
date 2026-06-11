import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/web-leads/unsubscribe?id=<contact uuid>
//
// One-click unsubscribe target for the web-lead follow-up email (CAN-SPAM
// requirement). The contact row's uuid IS the token — unguessable, and the
// worst an enumeration could do is unsubscribe someone (fail-safe direction).
// POST is supported for RFC 8058 one-click (List-Unsubscribe-Post).
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function unsubscribe(id: string): Promise<'done' | 'not_found'> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('web_lead_contacts')
    .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  return data ? 'done' : 'not_found';
}

function page(es: boolean, ok: boolean): string {
  const title = ok ? (es ? 'Listo — no le escribiremos más' : "Done — we won't email you again") : es ? 'Enlace no válido' : 'Invalid link';
  const body = ok
    ? es
      ? 'Su correo fue dado de baja de los seguimientos de Oiikon. Si cambia de opinión, siempre puede escribirnos en el chat de oiikon.com.'
      : 'Your email has been removed from Oiikon follow-ups. If you change your mind, you can always reach us in the chat at oiikon.com.'
    : es
      ? 'Este enlace de baja no es válido o ya fue usado.'
      : 'This unsubscribe link is invalid or was already used.';
  return `<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;color:#020817;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="background:#fff;border-radius:12px;padding:32px;max-width:420px;text-align:center;">
<h2 style="margin:0 0 12px;">${title}</h2><p style="line-height:1.5;color:#374151;">${body}</p>
<a href="https://oiikon.com" style="color:#F97316;">oiikon.com</a></div></body></html>`;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const id = (req.nextUrl.searchParams.get('id') ?? '').trim();
  const es = (req.nextUrl.searchParams.get('lang') ?? 'es') !== 'en';
  const ok = UUID_RE.test(id) ? (await unsubscribe(id)) === 'done' : false;
  if (ok) console.log(`[web-leads] unsubscribed ${id}`);
  return new NextResponse(page(es, ok), {
    status: ok ? 200 : 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

// RFC 8058 one-click unsubscribe (mail clients POST with no body semantics).
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
