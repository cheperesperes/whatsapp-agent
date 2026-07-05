/**
 * /api/setup/whatsapp-profile-status — UNAUTHENTICATED business-identity audit
 *
 * Returns ONLY customer-visible / status facts about the WhatsApp sender:
 * verified display name + its review status, Official Business Account flag,
 * quality rating, the public business profile fields (about, description,
 * address, email, websites, photo present), WABA review status, and whether
 * a product catalog is connected. No tokens, no IDs beyond the public phone
 * display, no message content. Everything here is what a customer can
 * already see by opening the chat profile — safe to expose for audits from
 * sessions without a Supabase login (same precedent as
 * /api/marketing/templates/public-status).
 *
 * Public-path entry must be added to middleware.ts PUBLIC_PATHS.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

async function graphGet(path: string, token: string): Promise<Record<string, unknown> | { __error: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json as { error?: { message?: string } }).error;
      return { __error: `${res.status}: ${err?.message ?? 'unknown'}` };
    }
    return json;
  } catch (e) {
    return { __error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(_req: NextRequest) {
  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ??
    process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return NextResponse.json({ ok: false, error: 'env missing' }, { status: 500 });
  }

  // 1) Phone number: the name customers see + OBA + quality.
  const phone = await graphGet(
    `${phoneNumberId}?fields=verified_name,display_phone_number,name_status,quality_rating,is_official_business_account,code_verification_status,whatsapp_business_account`,
    token,
  );

  // 2) Public business profile (what the chat profile page shows).
  const profileRes = await graphGet(
    `${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
    token,
  );
  const profile =
    '__error' in profileRes
      ? profileRes
      : ((profileRes as { data?: Record<string, unknown>[] }).data?.[0] ?? {});

  // 3) WABA review status + catalog connection (best-effort — some tokens
  //    lack catalog_management; report the error instead of failing).
  const wabaId =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
    ((phone as { whatsapp_business_account?: { id?: string } }).whatsapp_business_account?.id ?? null);

  let waba: Record<string, unknown> | { __error: string } | null = null;
  let catalogs: unknown = null;
  if (wabaId) {
    waba = await graphGet(`${wabaId}?fields=name,account_review_status`, token);
    const cat = await graphGet(`${wabaId}/product_catalogs?fields=name,product_count`, token);
    catalogs = '__error' in cat ? cat : ((cat as { data?: unknown[] }).data ?? []);
  }

  const p = profile as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    phone: '__error' in phone ? phone : {
      display_phone_number: (phone as Record<string, unknown>).display_phone_number ?? null,
      verified_name: (phone as Record<string, unknown>).verified_name ?? null,
      name_status: (phone as Record<string, unknown>).name_status ?? null,
      is_official_business_account: (phone as Record<string, unknown>).is_official_business_account ?? false,
      quality_rating: (phone as Record<string, unknown>).quality_rating ?? null,
    },
    business_profile: '__error' in p ? p : {
      about: p.about ?? null,
      description: p.description ?? null,
      address: p.address ?? null,
      email: p.email ?? null,
      websites: p.websites ?? [],
      vertical: p.vertical ?? null,
      has_profile_photo: Boolean(p.profile_picture_url),
    },
    waba_review_status: waba && !('__error' in waba) ? ((waba as Record<string, unknown>).account_review_status ?? null) : waba,
    catalogs,
  });
}
