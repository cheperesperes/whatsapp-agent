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

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    return NextResponse.json(
      { error: 'WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set in Vercel env.' },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { templateName, couponCode, audience = 'all', dryRun = false } = body || {};
  if (!templateName) {
    return NextResponse.json(
      { error: 'templateName is required (must be a Meta-approved template name)' },
      { status: 400 },
    );
  }

  const sb = createServiceClient();

  // 1. Resolve audience from customer_profiles
  let q = sb.from('customer_profiles').select('phone_number, display_name, language');
  if (audience === 'es') q = q.eq('language', 'es');
  else if (audience === 'en') q = q.eq('language', 'en');
  const { data: leads, error: leadsErr } = await q;
  if (leadsErr) {
    return NextResponse.json({ error: `Lead fetch error: ${leadsErr.message}` }, { status: 500 });
  }
  const recipList = (leads || []).map((l: any) => ({
    phone: l.phone_number,
    language: (l.language || 'es') as 'es' | 'en',
    name: l.display_name,
  }));
  if (recipList.length === 0) {
    return NextResponse.json({ error: 'No recipients matched audience filter.' }, { status: 400 });
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

  // 3. Dry-run mode returns plan
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      recipientCount: recipList.length,
      breakdownByLanguage: {
        es: recipList.filter((r) => r.language === 'es').length,
        en: recipList.filter((r) => r.language === 'en').length,
      },
      coupon: coupon
        ? {
            code: coupon.code,
            discount: coupon.discount_value,
            type: coupon.discount_type,
          }
        : null,
      templateName,
      sampleRecipients: recipList.slice(0, 5).map((r) => ({
        phone: r.phone,
        language: r.language,
        name: r.name,
      })),
    });
  }

  // 4. Real send loop — sequential w/ 200ms gap (Meta rate limit ~5/sec safe)
  const META_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`;
  const results: any[] = [];
  for (const r of recipList) {
    try {
      const lang = r.language;
      const param1 = r.name || (lang === 'en' ? 'friend' : 'amigo/a');
      const param2 = coupon?.code || '';
      const param3 = discountText(coupon, lang);
      const payload = {
        messaging_product: 'whatsapp',
        to: normalizePhone(r.phone),
        type: 'template',
        template: {
          name: templateName,
          language: { code: lang === 'en' ? 'en_US' : 'es' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: String(param1) },
                ...(param2 ? [{ type: 'text', text: String(param2) }] : []),
                ...(param3 ? [{ type: 'text', text: String(param3) }] : []),
              ],
            },
          ],
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
