/**
 * /api/marketing/send-offer
 *
 * Send a Meta-approved WhatsApp template offer to leads in customer_profiles.
 *
 * Reads coupon from SHARED Oiikon discount_codes table (single source of truth).
 * Respects per-recipient language. STRICT: never sends Spanish template to EN-preferring lead.
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

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits;
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

  // Prefer META_-prefixed env (where the never-expires System User token
  // lives — see lib/whatsapp.ts). Fall back to legacy unprefixed names so
  // dev envs that only set one still work.
  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
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
    return NextResponse.json(
      { error: 'templateName is required (must be a Meta-approved template name)' },
      { status: 400 },
    );
  }

  const sb = createServiceClient();

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
    // 1. Resolve audience from customer_profiles
    let q = sb.from('customer_profiles').select('phone_number, display_name, language');
    if (audience === 'es') q = q.eq('language', 'es');
    else if (audience === 'en') q = q.eq('language', 'en');
    const { data: leads, error: leadsErr } = await q;
    if (leadsErr) {
      return NextResponse.json({ error: `Lead fetch error: ${leadsErr.message}` }, { status: 500 });
    }
    recipList = (leads || []).map((l: any) => ({
      phone: l.phone_number,
      language: (l.language || 'es') as 'es' | 'en',
      name: l.display_name,
    }));
    if (recipList.length === 0) {
      return NextResponse.json({ error: 'No recipients matched audience filter.' }, { status: 400 });
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
      return NextResponse.json(
        { error: `Active coupon not found: ${couponCode}` },
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
      previewDebug,
    });
  }

  // 4. Discover the template's actual body-param count + language so the
  // payload matches what Meta expects. The oiikon_offer_* templates
  // currently only accept ONE param ({{1}} = recipient name); coupon code
  // and discount are hardcoded in the template body. Sending more params
  // than the template defines returns Meta error 132000.
  let bodyParamCount = 1;
  let templateLanguageCode: string | null = null;
  try {
    const wabaResolveRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}?fields=whatsapp_business_account`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    const wabaResolveData = await wabaResolveRes.json();
    const wabaId = wabaResolveData?.whatsapp_business_account?.id;
    if (wabaId) {
      const tRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,language,components&name=${encodeURIComponent(templateName)}&limit=10`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      const tData = await tRes.json();
      const tpl = (tData.data || []).find((x: any) => x.name === templateName);
      if (tpl) {
        templateLanguageCode = tpl.language || null;
        const bodyComp = (tpl.components || []).find(
          (c: any) => (c.type || '').toUpperCase() === 'BODY',
        );
        const m = (bodyComp?.text || '').match(/\{\{\s*\d+\s*\}\}/g);
        bodyParamCount = m ? m.length : 0;
      }
    }
  } catch {
    /* fall through with default bodyParamCount=1 */
  }

  // 5. Real send loop — sequential w/ 200ms gap (Meta rate limit ~5/sec safe)
  const META_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`;
  const results: any[] = [];
  for (const r of recipList) {
    try {
      const lang = r.language;
      const param1 = r.name || (lang === 'en' ? 'friend' : 'amigo/a');
      const param2 = coupon?.code || '';
      const param3 = discountText(coupon, lang);
      const allParams = [
        String(param1),
        ...(param2 ? [String(param2)] : []),
        ...(param3 ? [String(param3)] : []),
      ];
      const params = allParams.slice(0, bodyParamCount);
      const langCode = templateLanguageCode || (lang === 'en' ? 'en_US' : 'es');
      const payload = {
        messaging_product: 'whatsapp',
        to: normalizePhone(r.phone),
        type: 'template',
        template: {
          name: templateName,
          language: { code: langCode },
          components:
            params.length > 0
              ? [
                  {
                    type: 'body',
                    parameters: params.map((text) => ({ type: 'text', text })),
                  },
                ]
              : [],
        },
      };
      const res = await fetch(META_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        results.push({ phone: r.phone, language: lang, success: false, error: data });
      } else {
        results.push({
          phone: r.phone,
          language: lang,
          success: true,
          wa_message_id: data?.messages?.[0]?.id,
        });
      }
      // Log to messages table for trail
      try {
        await sb.from('messages').insert({
          role: 'system',
          content: `[OUTBOUND_OFFER] ${templateName} (${lang}) coupon=${coupon?.code || 'none'} to=${r.phone}`,
          handoff_detected: false,
        });
      } catch {}
    } catch (e: any) {
      results.push({ phone: r.phone, success: false, error: e?.message ?? String(e) });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const sentCount = results.filter((r) => r.success).length;
  const totalCount = results.length;
  return NextResponse.json(
    {
      ok: sentCount > 0,
      sentCount,
      totalCount,
      coupon: coupon
        ? { code: coupon.code, discount: coupon.discount_value, type: coupon.discount_type }
        : null,
      results,
    },
    { status: sentCount === totalCount ? 200 : sentCount > 0 ? 207 : 502 },
  );
}
