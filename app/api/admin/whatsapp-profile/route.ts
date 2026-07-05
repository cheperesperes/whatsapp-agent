import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Admin utility: read/update the WhatsApp Business PROFILE for Sol's number
// (the chat header customers see — photo, about, description, website, email).
// This profile IS the storefront for the ~80% of buyers who go FB ad → chat
// and never visit oiikon.com, so it must read as a real business, not a
// personal account.
//
// Auth: shared-secret token from ADMIN_PROFILE_TOKEN (env, not source — the
// send-product-email hardcoded-token pattern leaks the secret into the repo).
// Fails closed if the env var is unset.
//
// GET  ?token=…                → current profile (about, address, description,
//                                email, profile_picture_url, websites, vertical)
// POST ?token=… {fields}       → update any subset of: about, address,
//                                description, email, websites, vertical.
//   Display name + Official Business Account status are NOT settable here —
//   those go through Meta review in Business Manager.
// ─────────────────────────────────────────────────────────────────────────────

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

const READ_FIELDS =
  'about,address,description,email,profile_picture_url,websites,vertical';

// Fields Meta accepts on POST /{phone-number-id}/whatsapp_business_profile.
// profile_picture_handle intentionally omitted — photo upload needs the
// resumable-upload flow; do it in WhatsApp Manager instead.
const WRITABLE_FIELDS = [
  'about',
  'address',
  'description',
  'email',
  'websites',
  'vertical',
] as const;

function creds(): { accessToken: string; phoneNumberId: string } {
  const accessToken =
    process.env.META_WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  if (!accessToken || !phoneNumberId) {
    throw new Error('Missing Meta WhatsApp env vars');
  }
  return { accessToken, phoneNumberId };
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PROFILE_TOKEN ?? '';
  if (!expected) return false; // fail closed if the env var is missing
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? req.headers.get('x-profile-token') ?? '';
  return token === expected;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let accessToken: string, phoneNumberId: string;
  try {
    ({ accessToken, phoneNumberId } = creds());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/whatsapp_business_profile?fields=${READ_FIELDS}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return NextResponse.json({ error: 'meta_error', detail: json }, { status: 502 });
  }
  return NextResponse.json(json);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let accessToken: string, phoneNumberId: string;
  try {
    ({ accessToken, phoneNumberId } = creds());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const payload: Record<string, unknown> = { messaging_product: 'whatsapp' };
  for (const f of WRITABLE_FIELDS) {
    if (body[f] !== undefined) payload[f] = body[f];
  }
  if (Object.keys(payload).length === 1) {
    return NextResponse.json(
      { error: 'no writable fields', writable: WRITABLE_FIELDS },
      { status: 400 },
    );
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/whatsapp_business_profile`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return NextResponse.json({ error: 'meta_error', detail: json }, { status: 502 });
  }
  return NextResponse.json({ ok: true, updated: Object.keys(payload).filter((k) => k !== 'messaging_product'), meta: json });
}
