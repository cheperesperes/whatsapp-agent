/**
 * /api/marketing/templates/submit — create new Meta WhatsApp templates
 *
 * POST body:
 *   {
 *     templates: Array<{
 *       name: string;          // e.g. 'oiikon_offer_e3800_v2'
 *       language: string;      // BCP-47 like 'en_US' or 'es'
 *       category: string;      // 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
 *       components: TemplateComponent[];
 *     }>;
 *     dryRun?: boolean;        // returns the payload that would be POSTed
 *   }
 *
 * Submits each template via POST /{WABA_ID}/message_templates. Same name +
 * different language code is treated by Meta as a language variant — they
 * coexist under the same template namespace.
 *
 * Auth: requires signed-in Supabase user.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
// Meta submission can take several seconds per template; default 30s isn't
// enough for 4 sequential POSTs plus the WABA lookup.
export const maxDuration = 60;

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

export async function POST(req: NextRequest) {
  // Auth gate
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

  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ??
    process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token) {
    return NextResponse.json(
      { error: 'META_WHATSAPP_ACCESS_TOKEN not set in Vercel env.' },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { templates, dryRun = false } = body || {};
  if (!Array.isArray(templates) || templates.length === 0) {
    return NextResponse.json(
      { error: '`templates` (array) is required' },
      { status: 400 },
    );
  }

  // Resolve WABA — prefer env, fall back to phone_number_id lookup.
  let wabaId: string | null =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
    null;
  let wabaSource = wabaId ? 'env' : 'unset';
  if (!wabaId && phoneNumberId) {
    try {
      const pn = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const pnData = await pn.json();
      if (pn.ok && pnData?.whatsapp_business_account?.id) {
        wabaId = pnData.whatsapp_business_account.id;
        wabaSource = 'phone_lookup';
      }
    } catch {
      /* non-fatal */
    }
  }
  if (!wabaId) {
    return NextResponse.json(
      { error: 'Could not resolve WABA ID' },
      { status: 500 },
    );
  }

  const results: Array<Record<string, unknown>> = [];
  for (const t of templates) {
    if (!t?.name || !t?.language || !t?.category || !Array.isArray(t.components)) {
      results.push({
        name: t?.name,
        status: 'invalid',
        reason: 'missing name/language/category/components',
      });
      continue;
    }
    const payload = {
      name: t.name,
      language: t.language,
      category: t.category,
      components: t.components,
    };
    if (dryRun) {
      results.push({
        name: t.name,
        language: t.language,
        status: 'dry-run',
        payload,
      });
      continue;
    }
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const subData = await subRes.json();
      results.push({
        name: t.name,
        language: t.language,
        status: subRes.ok ? 'submitted' : 'error',
        http: subRes.status,
        meta: subData,
      });
    } catch (e: any) {
      results.push({
        name: t.name,
        language: t.language,
        status: 'exception',
        error: e?.message ?? String(e),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const submitted = results.filter((r) => r.status === 'submitted').length;
  const errored = results.filter((r) => r.status === 'error').length;
  return NextResponse.json({
    ok: errored === 0,
    waba_id: wabaId,
    waba_source: wabaSource,
    dryRun,
    counts: { submitted, errored, total: templates.length },
    results,
  });
}
