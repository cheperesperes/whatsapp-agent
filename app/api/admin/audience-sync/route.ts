/**
 * /api/admin/audience-sync — create/refresh the Meta Custom Audience from the
 * lead database and ensure its 1% US Lookalike exists.
 *
 * What it does (idempotent — safe to re-run monthly):
 *   1. Pulls every US customer/lead phone from conversations + customer_profiles
 *      + orders (opt-outs, test numbers and Sol's own line removed).
 *   2. Finds-or-creates the Custom Audience on the ad account and uploads the
 *      phones as SHA-256 hashes (Meta's customer-list matching format).
 *   3. Finds-or-creates the 1% US Lookalike seeded on that audience.
 *
 * Auth: shared-secret header `x-sync-token` compared against the app_config
 * row 'audience_sync_token' (service-role readable only). Fails closed when
 * the row is absent. No Meta tokens ever leave the server.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';
const CA_NAME = 'Oiikon — WhatsApp leads + buyers (auto)';
const LAL_NAME = 'LAL 1% — Oiikon leads USA (auto)';

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

// Meta phone-match normalization: digits only, with country code, no '+'.
function toMatchablePhone(raw: string | null | undefined): string | null {
  if (!raw || raw.startsWith('web::')) return null;
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null;
  if (!ten) return null;
  if (/^[01]/.test(ten)) return null; // invalid US area code
  if (/^555/.test(ten)) return null; // test numbers
  if (ten === '5617024893') return null; // Sol's own line
  return `1${ten}`;
}

async function graph(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export async function POST(req: NextRequest) {
  const sb = createServiceClient();

  // Auth: DB-stored shared secret (fail closed).
  const { data: tokenRow } = await sb
    .from('app_config')
    .select('value')
    .eq('key', 'audience_sync_token')
    .maybeSingle();
  const expected = tokenRow?.value ?? '';
  const provided = req.headers.get('x-sync-token') ?? '';
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const metaToken = process.env.META_PAGE_ACCESS_TOKEN ?? '';
  const adAccountId = process.env.META_AD_ACCOUNT_ID ?? '';
  if (!metaToken || !adAccountId) {
    return NextResponse.json(
      { error: 'META_PAGE_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set' },
      { status: 500 },
    );
  }

  // 1) Lead phones from the DB.
  const [convs, profiles, orders, optedOut] = await Promise.all([
    sb.from('conversations').select('phone_number').eq('channel', 'whatsapp'),
    sb.from('customer_profiles').select('phone_number'),
    sb.from('orders').select('customer_phone').not('customer_phone', 'is', null),
    sb.from('conversations').select('phone_number').eq('opted_out', true),
  ]);
  const excluded = new Set(
    (optedOut.data ?? [])
      .map((r: any) => toMatchablePhone(r.phone_number))
      .filter(Boolean) as string[],
  );
  const phones = new Set<string>();
  for (const r of convs.data ?? []) {
    const p = toMatchablePhone((r as any).phone_number);
    if (p && !excluded.has(p)) phones.add(p);
  }
  for (const r of profiles.data ?? []) {
    const p = toMatchablePhone((r as any).phone_number);
    if (p && !excluded.has(p)) phones.add(p);
  }
  for (const r of orders.data ?? []) {
    const p = toMatchablePhone((r as any).customer_phone);
    if (p && !excluded.has(p)) phones.add(p);
  }
  const hashes = [...phones].map((p) => sha256(p));
  if (hashes.length < 100) {
    return NextResponse.json(
      { error: `Only ${hashes.length} phones — Meta needs ≥100 for a customer list.` },
      { status: 400 },
    );
  }

  // 2) Find-or-create the Custom Audience.
  const act = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const list = await graph(`${act}/customaudiences?fields=name,subtype&limit=200`, metaToken);
  if (!list.ok) {
    return NextResponse.json(
      { step: 'list_audiences', error: list.json?.error ?? list.json },
      { status: 502 },
    );
  }
  let ca = (list.json.data ?? []).find((a: any) => a.name === CA_NAME) ?? null;
  if (!ca) {
    const created = await graph(`${act}/customaudiences`, metaToken, {
      method: 'POST',
      body: JSON.stringify({
        name: CA_NAME,
        subtype: 'CUSTOM',
        customer_file_source: 'USER_PROVIDED_ONLY',
        description: 'WhatsApp leads, learned profiles and buyers — synced from Sol DB',
      }),
    });
    if (!created.ok) {
      // Most common blocker: Custom Audience ToS not accepted for the account —
      // Meta returns a link the owner must click once. Surface it verbatim.
      return NextResponse.json(
        { step: 'create_audience', error: created.json?.error ?? created.json },
        { status: 502 },
      );
    }
    ca = { id: created.json.id, name: CA_NAME };
  }

  // 3) Upload hashes in batches of 500.
  const uploads: any[] = [];
  for (let i = 0; i < hashes.length; i += 500) {
    const batch = hashes.slice(i, i + 500);
    const up = await graph(`${ca.id}/users`, metaToken, {
      method: 'POST',
      body: JSON.stringify({
        payload: { schema: ['PHONE_SHA256'], data: batch.map((h) => [h]) },
      }),
    });
    uploads.push(up.ok ? { batch: i / 500, ...up.json } : { batch: i / 500, error: up.json?.error });
    if (!up.ok) break;
  }

  // 4) Find-or-create the 1% US Lookalike.
  let lal = (list.json.data ?? []).find((a: any) => a.name === LAL_NAME) ?? null;
  let lalResult: any = lal ? { id: lal.id, existed: true } : null;
  if (!lal) {
    const createdLal = await graph(`${act}/customaudiences`, metaToken, {
      method: 'POST',
      body: JSON.stringify({
        name: LAL_NAME,
        subtype: 'LOOKALIKE',
        origin_audience_id: ca.id,
        lookalike_spec: JSON.stringify({ ratio: 0.01, country: 'US' }),
      }),
    });
    lalResult = createdLal.ok
      ? { id: createdLal.json.id, existed: false }
      : { error: createdLal.json?.error ?? createdLal.json };
  }

  return NextResponse.json({
    ok: true,
    phones_uploaded: hashes.length,
    custom_audience: { id: ca.id, name: CA_NAME },
    uploads,
    lookalike: lalResult,
  });
}
