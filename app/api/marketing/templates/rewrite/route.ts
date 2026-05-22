/**
 * /api/marketing/templates/rewrite — bulk find/replace in Meta templates
 *
 * POST body:
 *   {
 *     from: string;          // text to remove (e.g. "familia cubana")
 *     to: string;            // replacement text (e.g. "familia")
 *     namePrefix?: string;   // only target templates whose name starts with this
 *     dryRun?: boolean;      // preview before/after without submitting to Meta
 *   }
 *
 * For each matching template:
 *  1. fetch its current `components`
 *  2. replace `from` → `to` in every BODY/HEADER/FOOTER text field
 *  3. POST the new components back to Meta (template re-enters PENDING for review)
 *
 * Meta only allows edits to APPROVED / PAUSED / DISABLED templates. Edited
 * templates return to PENDING for re-approval (24-48h typical). Variables
 * `{{n}}` are preserved as-is.
 *
 * Auth: requires a signed-in Supabase user (matches /api/marketing/send-offer).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

type TemplateComponent = {
  type?: string;
  text?: string;
  format?: string;
  example?: Record<string, unknown>;
  buttons?: Array<Record<string, unknown>>;
};

function replaceInComponents(
  components: TemplateComponent[],
  from: string,
  to: string,
): { newComps: TemplateComponent[]; changed: boolean } {
  let changed = false;
  const newComps = components.map((c) => {
    const next: TemplateComponent = { ...c };
    if (typeof next.text === 'string' && next.text.includes(from)) {
      next.text = next.text.split(from).join(to);
      changed = true;
    }
    // Button labels can also contain the phrase
    if (Array.isArray(next.buttons)) {
      next.buttons = next.buttons.map((b) => {
        const nb = { ...b } as Record<string, unknown>;
        if (typeof nb.text === 'string' && (nb.text as string).includes(from)) {
          nb.text = (nb.text as string).split(from).join(to);
          changed = true;
        }
        return nb;
      });
    }
    return next;
  });
  return { newComps, changed };
}

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
  if (!phoneNumberId) {
    return NextResponse.json(
      { error: 'META_WHATSAPP_PHONE_NUMBER_ID not set in Vercel env.' },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { from, to, namePrefix, dryRun = false } = body || {};
  if (typeof from !== 'string' || !from.length) {
    return NextResponse.json(
      { error: '`from` is required and must be a non-empty string' },
      { status: 400 },
    );
  }
  if (typeof to !== 'string') {
    return NextResponse.json(
      { error: '`to` is required and must be a string (empty string is ok)' },
      { status: 400 },
    );
  }

  // Resolve WABA — prefer phone_number_id lookup, fall back to env.
  let wabaId: string | null =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
    null;
  let wabaSource = wabaId ? 'env' : 'unset';
  let phoneLookupError: unknown = null;
  try {
    const wabaRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}?fields=whatsapp_business_account`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    const wabaData = await wabaRes.json();
    if (wabaRes.ok && wabaData?.whatsapp_business_account?.id) {
      wabaId = wabaData.whatsapp_business_account.id;
      wabaSource = 'phone_lookup';
    } else {
      phoneLookupError = wabaData;
    }
  } catch (e) {
    phoneLookupError = (e as Error).message;
  }
  if (!wabaId) {
    return NextResponse.json(
      {
        error: 'Could not resolve WABA ID',
        phone_lookup_error: phoneLookupError,
        phone_number_id_present: !!phoneNumberId,
      },
      { status: 502 },
    );
  }

  // Fetch templates (need IDs for the edit POST)
  const tplRes = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=id,name,language,status,category,components&limit=100`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  const tplData = await tplRes.json();
  if (!tplRes.ok) {
    return NextResponse.json(
      { error: 'Templates fetch failed', meta: tplData },
      { status: 502 },
    );
  }
  const allTpls = (tplData.data || []) as Array<{
    id: string;
    name: string;
    language: string;
    status: string;
    category?: string;
    components?: TemplateComponent[];
  }>;
  const targets = namePrefix
    ? allTpls.filter((t) => t.name?.startsWith(namePrefix))
    : allTpls;

  const results: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    const { newComps, changed } = replaceInComponents(t.components || [], from, to);
    if (!changed) {
      results.push({
        name: t.name,
        id: t.id,
        status: 'skipped',
        reason: 'no match',
      });
      continue;
    }
    const beforeBody = (t.components || []).find(
      (c) => (c.type || '').toUpperCase() === 'BODY',
    )?.text;
    const afterBody = newComps.find((c) => (c.type || '').toUpperCase() === 'BODY')
      ?.text;

    if (dryRun) {
      results.push({
        name: t.name,
        id: t.id,
        status: 'dry-run',
        before_body_excerpt: beforeBody?.slice(0, 220),
        after_body_excerpt: afterBody?.slice(0, 220),
      });
      continue;
    }

    // Submit to Meta — POST to /{template_id} with new components
    const editRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${t.id}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ components: newComps }),
      },
    );
    const editData = await editRes.json();
    results.push({
      name: t.name,
      id: t.id,
      status: editRes.ok ? 'submitted' : 'error',
      http: editRes.status,
      meta: editData,
      before_body_excerpt: beforeBody?.slice(0, 160),
      after_body_excerpt: afterBody?.slice(0, 160),
    });
    // Light rate-limit cushion
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const submitted = results.filter((r) => r.status === 'submitted').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return NextResponse.json({
    ok: errored === 0,
    waba_id: wabaId,
    waba_source: wabaSource,
    phone_lookup_error: phoneLookupError,
    from,
    to,
    namePrefix: namePrefix ?? null,
    dryRun,
    total_targets: targets.length,
    counts: { submitted, errored, skipped },
    results,
  });
}
