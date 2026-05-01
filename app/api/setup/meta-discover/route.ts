import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// ─────────────────────────────────────────────────────────────────────────────
// Meta ID discovery — one-shot helper.
//
// Paste a Facebook User or Page access token, get back every ID needed to
// fully configure Luz publishing: META_PAGE_ID, META_IG_ACCOUNT_ID,
// META_AD_ACCOUNT_ID, plus a long-lived Page Access Token derived from the
// user token.
//
// This endpoint NEVER writes to Vercel env vars — it just reads from Graph
// API and returns the values for the operator to paste manually. Writing
// env vars requires a Vercel API token which we don't want stored here.
//
// Required scopes on the provided token:
//   - pages_show_list
//   - pages_read_engagement
//   - pages_manage_posts         (for Facebook publishing)
//   - instagram_basic            (for Instagram linkage lookup)
//   - instagram_content_publish  (for Instagram publishing)
//   - ads_read                   (for ad spend metrics; optional)
//
// Auth: this endpoint is behind dashboard auth (Supabase cookie). Not
// callable anonymously.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const META_API = 'https://graph.facebook.com/v21.0';

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Fail CLOSED unless explicitly running in local development. Preview
  // deployments (VERCEL_ENV='preview') used to slip through and expose this
  // endpoint, which accepts a Meta access token in the body — high-risk leak
  // surface. Restrict pass-through to true local dev only.
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV === undefined && process.env.NODE_ENV !== 'production';
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  return Boolean(user);
}

interface Page {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string };
  tasks?: string[];
}

interface AdAccount {
  id: string; // "act_..."
  account_id: string;
  name: string;
  account_status?: number;
  currency?: string;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  }

  const results: Record<string, unknown> = {};
  const errors: string[] = [];

  // 1. Token debug — validates the token and reports its scopes + expiration.
  try {
    const debugRes = await fetch(
      `${META_API}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
    );
    const debugJson = await debugRes.json() as {
      data?: { is_valid?: boolean; scopes?: string[]; expires_at?: number; type?: string; app_id?: string };
      error?: { message?: string };
    };
    if (debugJson.error) errors.push(`debug_token: ${debugJson.error.message}`);
    else if (debugJson.data) {
      results.token_info = {
        valid: debugJson.data.is_valid,
        type: debugJson.data.type,
        scopes: debugJson.data.scopes ?? [],
        expires_at: debugJson.data.expires_at
          ? new Date(debugJson.data.expires_at * 1000).toISOString()
          : 'never',
      };
    }
  } catch (e) {
    errors.push(`debug_token fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Pages — walk the user's owned pages. For each page, also grab the
  //    page-scoped access token (needed for publishing) and the linked
  //    Instagram Business Account ID.
  try {
    const pagesRes = await fetch(
      `${META_API}/me/accounts?fields=id,name,access_token,instagram_business_account,tasks&access_token=${encodeURIComponent(token)}`
    );
    const pagesJson = await pagesRes.json() as { data?: Page[]; error?: { message?: string } };
    if (pagesJson.error) errors.push(`me/accounts: ${pagesJson.error.message}`);
    else {
      results.pages = (pagesJson.data ?? []).map((p) => ({
        META_PAGE_ID: p.id,
        name: p.name,
        META_IG_ACCOUNT_ID: p.instagram_business_account?.id ?? null,
        META_PAGE_ACCESS_TOKEN: p.access_token ?? null,
        tasks: p.tasks ?? [],
      }));
    }
  } catch (e) {
    errors.push(`me/accounts fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Ad accounts — user may own multiple, operator picks the right one.
  try {
    const adsRes = await fetch(
      `${META_API}/me/adaccounts?fields=account_id,name,account_status,currency&access_token=${encodeURIComponent(token)}`
    );
    const adsJson = await adsRes.json() as { data?: AdAccount[]; error?: { message?: string } };
    if (adsJson.error) errors.push(`me/adaccounts: ${adsJson.error.message}`);
    else {
      results.ad_accounts = (adsJson.data ?? []).map((a) => ({
        META_AD_ACCOUNT_ID: a.account_id,
        name: a.name,
        status: a.account_status === 1 ? 'ACTIVE' : `code:${a.account_status}`,
        currency: a.currency ?? null,
      }));
    }
  } catch (e) {
    errors.push(`me/adaccounts fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  return NextResponse.json({
    ok: errors.length === 0,
    results,
    errors: errors.length > 0 ? errors : undefined,
    hint:
      'Copia los valores de META_PAGE_ID, META_IG_ACCOUNT_ID, META_PAGE_ACCESS_TOKEN (de la página correcta) y META_AD_ACCOUNT_ID en Vercel → Settings → Environment Variables. El PAGE_ACCESS_TOKEN ya es page-scoped (no expira si cambias User token por long-lived).',
  });
}
