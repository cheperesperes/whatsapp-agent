/**
 * /api/marketing/templates/public-status — UNAUTHENTICATED template counts
 *
 * Returns ONLY aggregate counts by status — no template names, no body text,
 * no IDs, no debug fields. Safe to call from a cloud scheduler that doesn't
 * have a Supabase session.
 *
 * Used by the auto-approval-check routine: poll this endpoint hourly, when
 * approved >= 8 fire the staged 5-lead test from a logged-in session.
 *
 * Public-path entry must be added to middleware.ts PUBLIC_PATHS.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

export async function GET(_req: NextRequest) {
  const token =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ??
    process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return NextResponse.json(
      { ok: false, error: 'env missing' },
      { status: 500 },
    );
  }

  let wabaId: string | null =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ??
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??
    null;
  try {
    const pn = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}?fields=whatsapp_business_account`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    const pnData = await pn.json();
    if (pn.ok && pnData?.whatsapp_business_account?.id) {
      wabaId = pnData.whatsapp_business_account.id;
    }
  } catch {
    /* env fallback */
  }
  if (!wabaId) {
    return NextResponse.json({ ok: false, error: 'no waba' }, { status: 500 });
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=status&limit=100`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: 'meta', http: res.status },
        { status: 502 },
      );
    }
    const templates = (data.data ?? []) as Array<{ status: string }>;
    const counts: Record<string, number> = {};
    for (const t of templates) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return NextResponse.json({
      ok: true,
      total: templates.length,
      counts,
      approved: counts.APPROVED ?? 0,
      pending: counts.PENDING ?? 0,
      rejected: counts.REJECTED ?? 0,
      paused: counts.PAUSED ?? 0,
      disabled: counts.DISABLED ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'exception', detail: e?.message ?? String(e) },
      { status: 502 },
    );
  }
}
