/**
 * /api/marketing/send-offer
 *
 * Send a Meta-approved WhatsApp template offer to leads in customer_profiles.
 *
 * Reads coupon from SHARED Oiikon discount_codes table (single source of truth).
 * Respects per-recipient language. STRICT: each lead gets the template variant
 * matching their language; leads whose language has no approved variant are
 * skipped — never sent wrong-language content.
 *
 * Body:
 *   {
 *     templateName: string;          // Meta-approved template, e.g. 'oiikon_offer_v1'
 *     couponCode: string;            // looked up in discount_codes
 *     audience?: 'all' | 'es' | 'en';
 *     dryRun?: boolean;
 *     testPhone?: string;            // single-phone delivery test (bypasses audience)
 *     testPhones?: string[];         // multi-phone delivery test for staged blasts
 *     testLanguage?: 'es' | 'en';
 *     testName?: string;
 *   }
 *
 * Returns:
 *   { ok, sentCount, totalCount, skippedCount, coupon, results[] }
 *
 * Auth: requires authenticated user via Supabase server client (matches /api/marketing/campaigns pattern).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createServerClient } from '@supabase/ssr';
import { waitUntil } from '@vercel/functions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'nodejs';
export const maxDuration = 60;

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

// ── Attempt audit log ────────────────────────────────────────────────────────
// Every attempt (rejections included) writes one outbound_offer_runs row so a
// failed blast is diagnosable after the fact. Fire-and-forget: logging must
// never break the send path.
type RunLog = {
  template_name?: string | null;
  coupon_code?: string | null;
  audience?: string | null;
  dry_run?: boolean;
  outcome: string;
  http_status?: number;
  error?: string | null;
  sent_count?: number;
  skipped_count?: number;
  total_count?: number;
  detail?: unknown;
};
async function logRun(sb: ReturnType<typeof createServiceClient>, entry: RunLog): Promise<void> {
  try {
    await sb.from('outbound_offer_runs').insert(entry as Record<string, unknown>);
  } catch {
    /* never block the send path on logging */
  }
}


function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits;
}

// Canonicalize any input to US E.164 ("+1XXXXXXXXXX"), or null if it isn't a
// valid US phone. Used to merge recipients across customer_profiles,
// conversations and orders on one stable key. customer_profiles already store
// "+1XXXXXXXXXX", so existing numbers (and their [OUTBOUND_OFFER] dedupe logs)
// canonicalize to the exact same string — the 24h dedupe keeps matching.
function toE164US(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('web::')) return null; // chat-session id, not a phone
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null; // non-US / invalid → dropped (Oiikon is USA-only)
}

function discountText(coupon: any, lang: 'es' | 'en'): string {
  if (!coupon) return '';
  const isPercent = coupon.discount_type === 'percentage';
  return isPercent
    ? `${Number(coupon.discount_value)}%`
    : `$${Number(coupon.discount_value).toFixed(0)}`;
}

export async function POST(req: NextRequest) {
  // Auth gate (same pattern as /api/marketing/campaigns)
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

  // Service client early: the attempt-audit logRun() calls on the early
  // rejection paths below need it before the main body runs.
  const sb = createServiceClient();

  // Prefer META_-prefixed env (where the never-expires System User token
  // lives — see lib/whatsapp.ts). Fall back to legacy unprefixed names so
  // dev envs that only set one still work.
  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    await logRun(sb, { outcome: 'rejected_env_missing', http_status: 500, error: 'Meta env vars not set' });
    return NextResponse.json(
      { error: 'META_WHATSAPP_ACCESS_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID not set in Vercel env.' },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const {
    templateName,
    couponCode,
    audience = 'all',
    dryRun = false,
    // testPhone bypasses audience resolution and sends to one phone.
    // testPhones (array) bypasses audience and sends to N phones — used
    // for staged rollouts (5 leads first → verify delivery → blast rest).
    // For test* recipients, we still look them up in customer_profiles
    // to pick up display_name / language; testLanguage / testName are
    // fallbacks for phones not yet in the table.
    testPhone,
    testPhones,
    testLanguage,
    testName,
    // When false (default) the audience send skips any lead that already got
    // an OUTBOUND_OFFER in the last 24h, so re-running doesn't double-message
    // a batch already sent today. Set true to deliberately re-send.
    includeRecentlyMessaged = false,
  } = body || {};
  if (!templateName) {
    await logRun(sb, { outcome: 'rejected_no_template', http_status: 400, error: 'templateName missing' });
    return NextResponse.json(
      { error: 'templateName is required (must be a Meta-approved template name)' },
      { status: 400 },
    );
  }

// (service client created above, before the early-exit audit logs)

  // Set when the audience path drops leads already messaged in the last 24h.
  // Surfaced in the dry-run plan so the operator sees the dedupe before sending.
  let skippedRecentlyMessaged = 0;

  let recipList: Array<{ phone: string; language: 'es' | 'en'; name: string | null }>;
  if (Array.isArray(testPhones) && testPhones.length > 0) {
    const phones = testPhones.map(String);
    const { data: known } = await sb
      .from('customer_profiles')
      .select('phone_number, display_name, language')
      .in('phone_number', phones);
    const byPhone = new Map(
      (known || []).map((l: any) => [l.phone_number, l]),
    );
    recipList = phones.map((p) => {
      const k = byPhone.get(p);
      return {
        phone: p,
        language: ((k?.language || testLanguage || 'es') === 'en' ? 'en' : 'es') as
          | 'es'
          | 'en',
        name: k?.display_name || testName || null,
      };
    });
  } else if (testPhone) {
    recipList = [
      {
        phone: String(testPhone),
        language: (testLanguage === 'en' ? 'en' : 'es') as 'es' | 'en',
        name: testName || null,
      },
    ];
  } else {
    // 1. Resolve audience from a UNION of every WhatsApp contact we hold:
    //    customer_profiles (authoritative name + language), conversations
    //    (anyone who's chatted) and orders (buyers). Pulling from
    //    customer_profiles alone missed ~45 US numbers that had chatted or
    //    bought but never got a profile row. Merge on a canonical US-E.164
    //    phone so each person appears exactly once.
    const [profilesRes, convRes, ordersRes] = await Promise.all([
      sb.from('customer_profiles').select('phone_number, display_name, language'),
      sb.from('conversations').select('phone_number, customer_name, opted_out'),
      sb.from('orders').select('customer_phone, customer_name'),
    ]);
    if (profilesRes.error) {
      return NextResponse.json({ error: `Lead fetch error: ${profilesRes.error.message}` }, { status: 500 });
    }

    // STOP/BAJA opt-out is tracked on conversations.opted_out — never message
    // anyone who opted out, regardless of which source surfaced their number.
    const optedOut = new Set<string>();
    for (const c of convRes.data || []) {
      if ((c as any).opted_out) {
        const e = toE164US((c as any).phone_number);
        if (e) optedOut.add(e);
      }
    }

    // Merge lowest-precedence first (orders → conversations → profiles) so a
    // profile's real language/name wins; a name only upgrades (a later null
    // never clobbers an earlier real name). Contacts with no stored language
    // (conversations/orders) default to 'es' — the dominant market; the Meta
    // template ships es + en variants either way.
    const byPhone = new Map<string, { phone: string; language: 'es' | 'en'; name: string | null }>();
    const upsert = (e164: string, language: 'es' | 'en', name: string | null) => {
      const prev = byPhone.get(e164);
      byPhone.set(e164, { phone: e164, language, name: name ?? prev?.name ?? null });
    };
    for (const o of ordersRes.data || []) {
      const e = toE164US((o as any).customer_phone);
      if (e) upsert(e, 'es', (o as any).customer_name ?? null);
    }
    for (const c of convRes.data || []) {
      const e = toE164US((c as any).phone_number);
      if (e) upsert(e, 'es', (c as any).customer_name ?? null);
    }
    for (const p of profilesRes.data || []) {
      const e = toE164US((p as any).phone_number);
      if (e) upsert(e, ((p as any).language === 'en' ? 'en' : 'es'), (p as any).display_name ?? null);
    }
    for (const e of optedOut) byPhone.delete(e);

    recipList = Array.from(byPhone.values());

    // Audience filter on the resolved per-recipient language (STRICT: never
    // send a Spanish template to an EN-preferring lead, or vice versa).
    if (audience === 'es') recipList = recipList.filter((r) => r.language === 'es');
    else if (audience === 'en') recipList = recipList.filter((r) => r.language === 'en');

    if (recipList.length === 0) {
      await logRun(sb, { template_name: templateName, coupon_code: couponCode ?? null, audience, outcome: 'rejected_no_recipients', http_status: 400, error: 'No valid US recipients matched audience filter' });
      return NextResponse.json({ error: 'No valid US recipients matched audience filter.' }, { status: 400 });
    }

    // Dedupe: drop leads who already received an OUTBOUND_OFFER in the last
    // 24h so a re-run reaches only the remaining audience instead of
    // double-messaging the batch already sent today.
    if (!includeRecentlyMessaged) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentOffers } = await sb
        .from('messages')
        .select('content')
        .like('content', '[OUTBOUND_OFFER]%')
        .gte('created_at', since);
      const messaged = new Set<string>();
      for (const row of recentOffers || []) {
        const m = String((row as any).content).match(/to=(\+?\d+)/);
        if (m) messaged.add(m[1]);
      }
      const before = recipList.length;
      recipList = recipList.filter((r) => !messaged.has(r.phone));
      skippedRecentlyMessaged = before - recipList.length;
    }
    if (recipList.length === 0) {
      await logRun(sb, { template_name: templateName, coupon_code: couponCode ?? null, audience, outcome: 'rejected_all_deduped_24h', http_status: 400, skipped_count: skippedRecentlyMessaged, error: 'all recipients messaged in last 24h' });
      return NextResponse.json(
        {
          error:
            'No recipients left after skipping leads messaged in the last 24h. Set includeRecentlyMessaged=true to re-send anyway.',
          skippedRecentlyMessaged,
        },
        { status: 400 },
      );
    }
  }

  // 2. Resolve coupon from shared Oiikon discount_codes table
  let coupon: any = null;
  if (couponCode) {
    const { data } = await sb
      .from('discount_codes')
      .select('*')
      .eq('code', couponCode)
      .eq('is_active', true)
      .maybeSingle();
    coupon = data;
    if (!coupon) {
      // Self-service error: show which codes ARE usable right now, so an
      // operator picking a deactivated code (the #1 cause of "offers won't
      // send") can fix it without leaving the screen.
      const { data: activeCodes } = await sb
        .from('discount_codes')
        .select('code')
        .eq('is_active', true)
        .order('code');
      const available = (activeCodes ?? []).map((c: { code: string }) => c.code).join(', ');
      await logRun(sb, { template_name: templateName, coupon_code: couponCode, audience, outcome: 'rejected_coupon_inactive', http_status: 404, error: `coupon not active: ${couponCode}`, detail: { active_codes: available } });
      return NextResponse.json(
        { error: `Active coupon not found: ${couponCode}. Códigos activos disponibles: ${available || '(ninguno)'}` },
        { status: 404 },
      );
    }
  }

  // 3. Dry-run mode returns plan + rendered template preview
  if (dryRun) {
    // Fetch the Meta template components so the UI can render an exact
    // WhatsApp-bubble preview of what each recipient sees. We try both
    // languages so the preview matches per-language audience splits.
    const templatePreviews: Array<{
      language: string;
      header?: { type: string; link?: string | null; text?: string | null };
      body?: { text: string; rendered: string };
      footer?: { text: string };
      buttons?: Array<{ type: string; text: string; url?: string | null }>;
    }> = [];
    let previewDebug: any = null;
    try {
      // Mirror /api/marketing/templates WABA resolution: env first, then
      // phone-number lookup as fallback. Pure phone-lookup was returning
      // wabaResolveOk=false in prod even though the same call works in
      // the templates route — env-cached value is more reliable.
      let wabaId: string | null =
        process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
        process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
        null;
      let wabaSource = wabaId ? 'env' : 'unset';
      if (!wabaId && phoneId) {
        const wabaResolveRes = await fetch(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}?fields=whatsapp_business_account`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        );
        const wabaResolveData = await wabaResolveRes.json();
        if (wabaResolveRes.ok && wabaResolveData?.whatsapp_business_account?.id) {
          wabaId = wabaResolveData.whatsapp_business_account.id;
          wabaSource = 'phone_lookup';
        }
      }
      previewDebug = { wabaId: wabaId ?? null, wabaSource };
      if (wabaId) {
        const tRes = await fetch(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,language,components&limit=100`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        );
        const tData = await tRes.json();
        const allTemplates = tData.data || [];
        previewDebug = {
          ...previewDebug,
          templatesOk: tRes.ok,
          templatesCount: allTemplates.length,
          matchedCount: allTemplates.filter((x: any) => x.name === templateName).length,
        };
        for (const tpl of allTemplates) {
          if (tpl.name !== templateName) continue;
          const tplLang = tpl.language || 'es';
          // Prefer a real recipient's display_name so the preview shows
          // exactly what the first lead receives (not a generic placeholder).
          // Match by language first if possible, fall back to anyone, then
          // fall back to the literal placeholder.
          const realRecipient =
            recipList.find((r) => r.name && r.language === (tplLang.startsWith('en') ? 'en' : 'es')) ||
            recipList.find((r) => r.name) ||
            null;
          const sampleName =
            realRecipient?.name || (tplLang.startsWith('en') ? 'friend' : 'amigo/a');
          const sampleCode = coupon?.code || '';
          const sampleDiscount = discountText(coupon, tplLang.startsWith('en') ? 'en' : 'es');
          const sub = [sampleName, sampleCode, sampleDiscount];
          let header: any;
          let body: any;
          let footer: any;
          let buttons: any[] | undefined;
          for (const comp of tpl.components || []) {
            const type = (comp.type || '').toUpperCase();
            if (type === 'HEADER') {
              header = {
                type: comp.format || 'TEXT',
                link:
                  comp.example?.header_handle?.[0] ||
                  comp.example?.header_url?.[0] ||
                  null,
                text: comp.text || null,
              };
            } else if (type === 'BODY') {
              const raw = comp.text || '';
              const rendered = raw.replace(/\{\{\s*(\d+)\s*\}\}/g, (_: string, n: string) => {
                const idx = Number(n) - 1;
                return sub[idx] ?? `{{${n}}}`;
              });
              body = { text: raw, rendered };
            } else if (type === 'FOOTER') {
              footer = { text: comp.text || '' };
            } else if (type === 'BUTTONS') {
              buttons = (comp.buttons || []).map((b: any) => ({
                type: (b.type || '').toUpperCase(),
                text: b.text || '',
                url: b.url || null,
              }));
            }
          }
          templatePreviews.push({ language: tplLang, header, body, footer, buttons });
        }
      }
    } catch (e: any) {
      previewDebug = { error: e?.message ?? String(e) };
    }

    await logRun(sb, { template_name: templateName, coupon_code: coupon?.code ?? null, audience, dry_run: true, outcome: 'dry_run', total_count: recipList.length, skipped_count: skippedRecentlyMessaged });
    return NextResponse.json({
      dryRun: true,
      recipientCount: recipList.length,
      skippedRecentlyMessaged,
      breakdownByLanguage: {
        es: recipList.filter((r) => r.language === 'es').length,
        en: recipList.filter((r) => r.language === 'en').length,
      },
      coupon: coupon
        ? {
            code: coupon.code,
            discount: coupon.discount_value,
            type: coupon.discount_type,
            // Surface eligibility so the operator sees, before blasting, that
            // a brand/min-order-restricted coupon won't work for every lead.
            eligible_brand: coupon.eligible_brand ?? null,
            min_order_total: coupon.min_order_total ?? null,
          }
        : null,
      templateName,
      sampleRecipients: recipList.slice(0, 5).map((r) => ({
        phone: r.phone,
        language: r.language,
        name: r.name,
      })),
      templatePreviews,
      // Strict-language plan: which languages the template exists in and how
      // many recipients would be skipped for lacking a variant. null when the
      // template lookup failed (the send path then best-guesses per lead
      // instead of skipping).
      availableTemplateLanguages: templatePreviews.map((p) => p.language),
      willSkipLanguageMismatch:
        templatePreviews.length > 0
          ? {
              es: templatePreviews.some((p) => p.language.toLowerCase().startsWith('es'))
                ? 0
                : recipList.filter((r) => r.language === 'es').length,
              en: templatePreviews.some((p) => p.language.toLowerCase().startsWith('en'))
                ? 0
                : recipList.filter((r) => r.language === 'en').length,
            }
          : null,
      previewDebug,
    });
  }

  // 4. Discover the template's language variants + body-param counts so the
  // payload matches what Meta expects. The oiikon_offer_* templates
  // currently only accept ONE param ({{1}} = recipient name); coupon code
  // and discount are hardcoded in the template body. Sending more params
  // than the template defines returns Meta error 132000.
  //
  // A template name can exist in several language variants (es + en_US…) and
  // each recipient must get the variant matching their language. Resolving a
  // single global language code here used to deliver whichever variant Meta
  // listed first to EVERYONE — Spanish to EN-preferring leads. variantFor()
  // picks per recipient; sendOne skips leads with no matching variant. Only
  // if the lookup fails entirely (variants empty) does sendOne fall back to a
  // best-guess language code per lead.
  type TplVariant = { language: string; bodyParamCount: number };
  const variants: TplVariant[] = [];
  try {
    // WABA id: env first, phone-number lookup as fallback — phone lookup
    // alone was unreliable in prod (see the dry-run preview block above).
    let wabaId: string | null =
      process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
      process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
      null;
    if (!wabaId) {
      const wabaResolveRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const wabaResolveData = await wabaResolveRes.json();
      wabaId = wabaResolveData?.whatsapp_business_account?.id ?? null;
    }
    if (wabaId) {
      const tRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,language,components&name=${encodeURIComponent(templateName)}&limit=10`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const tData = await tRes.json();
      for (const tpl of tData.data || []) {
        if (tpl.name !== templateName) continue;
        const bodyComp = (tpl.components || []).find(
          (c: any) => (c.type || '').toUpperCase() === 'BODY',
        );
        const m = (bodyComp?.text || '').match(/\{\{\s*\d+\s*\}\}/g);
        variants.push({ language: tpl.language || 'es', bodyParamCount: m ? m.length : 0 });
      }
    }
  } catch {
    /* fall through with no variants — sendOne best-guesses per lead */
  }
  const variantFor = (lang: 'es' | 'en'): TplVariant | null =>
    variants.find((v) => v.language.toLowerCase().startsWith(lang)) ?? null;

  // 5. Real send loop — sequential w/ 200ms gap (Meta rate limit ~5/sec safe).
  // Each send logs an [OUTBOUND_OFFER] row, which both gives an audit trail AND
  // powers the 24h dedupe above — so even a backgrounded run is re-run-safe.
  const META_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`;

  async function sendOne(r: { phone: string; language: 'es' | 'en'; name: string | null }) {
    const lang = r.language;
    const variant = variantFor(lang);
    if (!variant && variants.length > 0) {
      // Strict-language rule: the template exists, but not in this lead's
      // language. Skip — never deliver wrong-language content. Skips are not
      // logged as [OUTBOUND_OFFER], so the lead stays reachable the moment a
      // template with their language variant is used.
      return {
        phone: r.phone,
        language: lang,
        success: false,
        skipped: 'no_template_variant_for_language',
      };
    }
    const param1 = r.name || (lang === 'en' ? 'friend' : 'amigo/a');
    const param2 = coupon?.code || '';
    const param3 = discountText(coupon, lang);
    const allParams = [
      String(param1),
      ...(param2 ? [String(param2)] : []),
      ...(param3 ? [String(param3)] : []),
    ];
    const params = allParams.slice(0, variant?.bodyParamCount ?? 1);
    const langCode = variant?.language ?? (lang === 'en' ? 'en_US' : 'es');
    const payload = {
      messaging_product: 'whatsapp',
      to: normalizePhone(r.phone),
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode },
        components:
          params.length > 0
            ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
            : [],
      },
    };
    let result: any;
    try {
      const res = await fetch(META_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      result = res.ok
        ? { phone: r.phone, language: lang, success: true, wa_message_id: data?.messages?.[0]?.id }
        : { phone: r.phone, language: lang, success: false, error: data };
    } catch (e: any) {
      result = { phone: r.phone, success: false, error: e?.message ?? String(e) };
    }
    // Log only successful sends so the dedupe never skips someone who didn't
    // actually receive it (a failed attempt should remain re-sendable).
    if (result.success) {
      try {
        await sb.from('messages').insert({
          role: 'system',
          content: `[OUTBOUND_OFFER] ${templateName} (${lang}) coupon=${coupon?.code || 'none'} to=${r.phone}`,
          handoff_detected: false,
        });
      } catch {}
    }
    return result;
  }

  async function runBatch(list: typeof recipList) {
    const out: any[] = [];
    for (const r of list) {
      out.push(await sendOne(r));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return out;
  }

  // No-502 fix: a large blast (>20) takes longer than the function timeout if
  // run inline (270 recipients × ~250ms ≈ 110s → Vercel kills it → 502, after
  // partially sending). Run big batches in the BACKGROUND via waitUntil and
  // return 202 immediately with the planned count. Small batches/tests run
  // inline so the operator gets exact per-recipient results.
  const BACKGROUND_THRESHOLD = 20;
  if (recipList.length > BACKGROUND_THRESHOLD) {
    await logRun(sb, { template_name: templateName, coupon_code: coupon?.code ?? null, audience, outcome: 'queued_background', http_status: 202, total_count: recipList.length, skipped_count: skippedRecentlyMessaged });
    waitUntil(
      runBatch(recipList).then((results) =>
        logRun(sb, {
          template_name: templateName,
          coupon_code: coupon?.code ?? null,
          audience,
          outcome: 'background_complete',
          sent_count: results.filter((r: any) => r.success).length,
          total_count: results.length,
          skipped_count: results.filter((r: any) => r.skipped).length,
          detail: { failures: results.filter((r: any) => !r.success && !r.skipped).slice(0, 10) },
        }),
      ),
    );
    return NextResponse.json(
      {
        ok: true,
        queued: true,
        queuedCount: recipList.length,
        skippedRecentlyMessaged,
        coupon: coupon
          ? { code: coupon.code, discount: coupon.discount_value, type: coupon.discount_type }
          : null,
        note: `Enviando ${recipList.length} ofertas en segundo plano. Cada envío se registra; vuelve a ejecutar para alcanzar a quien falte (los ya enviados se omiten 24h).`,
      },
      { status: 202 },
    );
  }

  const results = await runBatch(recipList);

  const sentCount = results.filter((r) => r.success).length;
  const skippedLanguageMismatch = results.filter(
    (r) => r.skipped === 'no_template_variant_for_language',
  ).length;
  const totalCount = results.length;
  await logRun(sb, {
    template_name: templateName,
    coupon_code: coupon?.code ?? null,
    audience,
    outcome: 'complete',
    http_status: sentCount === totalCount ? 200 : sentCount > 0 ? 207 : 502,
    sent_count: sentCount,
    total_count: totalCount,
    skipped_count: skippedLanguageMismatch,
    detail: { failures: results.filter((r: any) => !r.success && !r.skipped).slice(0, 10) },
  });
  return NextResponse.json(
    {
      ok: sentCount > 0,
      sentCount,
      totalCount,
      skippedLanguageMismatch,
      coupon: coupon
        ? { code: coupon.code, discount: coupon.discount_value, type: coupon.discount_type }
        : null,
      results,
    },
    { status: sentCount === totalCount ? 200 : sentCount > 0 ? 207 : 502 },
  );
}
