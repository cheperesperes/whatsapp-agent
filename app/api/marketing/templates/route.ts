/**
 * /api/marketing/templates — list Meta WhatsApp template approval status
 *
 * Read-only GET. Hits Meta Graph API:
 *   GET /v{version}/{WABA_ID}/message_templates
 *
 * Returns each template with name, language, category, status
 * (APPROVED / PENDING / REJECTED / DISABLED / etc.) so the Send Offer
 * panel can show which templates are actually usable. Without this, the
 * only way to check approval was the Meta Business Manager UI.
 *
 * Auth: same pattern as /api/marketing/send-offer (Supabase server client).
 * Env required: WHATSAPP_ACCESS_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

export async function GET(req: NextRequest) {
  // Auth gate (mirrors send-offer). In prod requires a signed-in user;
  // in dev (no Supabase env) it's open.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  // Memory project_oiikon_wa_secrets_locations_2026_05_20.md confirms
  // WABA "Oiikon Help" = 1505365390974343. Allow env override so a
  // future WABA migration doesn't require a code change.
  const wabaId =
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '1505365390974343';

  if (!token) {
    return NextResponse.json(
      { error: 'WHATSAPP_ACCESS_TOKEN not set in Vercel env.' },
      { status: 500 },
    );
  }

  const url =
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates` +
    `?fields=name,language,status,category,quality_score&limit=100`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Meta API error', meta: data, status: res.status },
        { status: 502 },
      );
    }

    // Light reshape so the panel can show counts by status without
    // re-parsing the payload.
    const templates = (data.data ?? []) as Array<{
      name: string;
      language: string;
      status: string;
      category?: string;
      quality_score?: { score?: string };
    }>;

    const byStatus: Record<string, number> = {};
    for (const t of templates) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      waba_id: wabaId,
      total: templates.length,
      by_status: byStatus,
      templates: templates.map((t) => ({
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        quality: t.quality_score?.score ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'fetch failed', detail: (err as Error).message },
      { status: 502 },
    );
  }
}
