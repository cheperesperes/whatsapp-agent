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

  // Prefer META_-prefixed env names — that's where the never-expires
  // System User token lives (see lib/whatsapp.ts). Legacy unprefixed
  // names still work as fallback so dev envs aren't broken. We hit
  // Meta error 190 (expired token) until this precedence was fixed —
  // the unprefixed env still holds the OLD token that died 2026-04-12.
  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ??
    process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'WHATSAPP_ACCESS_TOKEN not set in Vercel env.' },
      { status: 500 },
    );
  }

  // Discover WABA dynamically from the phone-number-id — env-stored WABA
  // ("1505365390974343") was rejected by Meta as not_found after we rotated
  // to a new System User token on 2026-05-22, suggesting the env value is
  // either stale or pointing at a WABA the new token can't see. Querying
  // /{phone_number_id}?fields=whatsapp_business_account returns the WABA
  // the token DOES have access to.
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ??
    process.env.WHATSAPP_PHONE_NUMBER_ID;
  let wabaId: string | null =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
    null;
  let wabaSource = wabaId ? 'env' : 'unset';
  let phoneLookupError: unknown = null;

  if (phoneNumberId) {
    try {
      const pnRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const pnData = await pnRes.json();
      if (pnRes.ok && pnData?.whatsapp_business_account?.id) {
        wabaId = pnData.whatsapp_business_account.id;
        wabaSource = 'phone_lookup';
      } else {
        phoneLookupError = pnData;
      }
    } catch (e) {
      phoneLookupError = (e as Error).message;
    }
  }

  if (!wabaId) {
    return NextResponse.json(
      {
        error: 'Could not resolve WABA ID',
        phone_lookup_error: phoneLookupError,
        phone_number_id_present: !!phoneNumberId,
      },
      { status: 500 },
    );
  }

  const url =
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates` +
    `?fields=name,language,status,category,quality_score,components&limit=100`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        {
          error: 'Meta API error',
          meta: data,
          status: res.status,
          // Surface non-sensitive bits of what was tried so we can diagnose
          // wrong WABA IDs without revealing the token. Last-4 of the token
          // helps confirm Vercel picked up the updated env value vs. cached
          // the old one.
          debug: {
            waba_id_tried: wabaId,
            waba_id_source: wabaSource,
            token_source: process.env.META_WHATSAPP_ACCESS_TOKEN
              ? 'META_WHATSAPP_ACCESS_TOKEN'
              : process.env.WHATSAPP_ACCESS_TOKEN
              ? 'WHATSAPP_ACCESS_TOKEN'
              : 'none',
            token_last4: token.slice(-4),
            graph_version: META_GRAPH_VERSION,
          },
        },
        { status: 502 },
      );
    }

    // Light reshape so the panel can show counts by status without
    // re-parsing the payload.
    type TplComponent = {
      type?: string;
      text?: string;
      example?: { body_text?: string[][] };
    };
    const templates = (data.data ?? []) as Array<{
      name: string;
      language: string;
      status: string;
      category?: string;
      quality_score?: { score?: string };
      components?: TplComponent[];
    }>;

    const countBodyParams = (comps: TplComponent[] | undefined): number => {
      const body = (comps || []).find((c) => (c.type || '').toUpperCase() === 'BODY');
      if (!body || !body.text) return 0;
      const m = body.text.match(/\{\{\s*\d+\s*\}\}/g);
      return m ? m.length : 0;
    };

    const byStatus: Record<string, number> = {};
    for (const t of templates) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    }

    // Surface which phone number is connected to this WABA so we can
    // catch stale env values. display_phone_number is publishable info.
    let wabaPhoneNumbers: Array<{
      id: string;
      display_phone_number: string;
      verified_name?: string;
    }> = [];
    try {
      const phonesRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const phonesData = await phonesRes.json();
      if (phonesRes.ok && Array.isArray(phonesData.data)) {
        wabaPhoneNumbers = phonesData.data;
      }
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({
      ok: true,
      waba_id: wabaId,
      waba_phone_numbers: wabaPhoneNumbers,
      env_phone_number_id: phoneNumberId,
      env_phone_matches_waba: wabaPhoneNumbers.some((p) => p.id === phoneNumberId),
      total: templates.length,
      by_status: byStatus,
      templates: templates.map((t) => ({
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        quality: t.quality_score?.score ?? null,
        body_param_count: countBodyParams(t.components),
        components: t.components,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'fetch failed', detail: (err as Error).message },
      { status: 502 },
    );
  }
}
