// ============================================================
// Google Ads spend — live read via the Google Ads API
// ------------------------------------------------------------
// Mirror of lib/marketing/ads-insights.ts (Meta) for Google. Reads
// cost totals for today / this week / this month so the Negocio board can
// show live Google spend and the social-stats cron can auto-log the weekly
// figure into `ad_spend` (channel='google') — exactly like Facebook.
//
// Auth is OAuth2 (installed-app refresh-token flow) + a Google Ads developer
// token. Everything is read from env; if any piece is missing the caller
// guards with `hasGoogleAds()` and skips gracefully (no throw on the hot path).
//
//   GOOGLE_ADS_DEVELOPER_TOKEN     – from your Google Ads API Center
//   GOOGLE_ADS_CLIENT_ID           – OAuth client (Google Cloud console)
//   GOOGLE_ADS_CLIENT_SECRET       – OAuth client secret
//   GOOGLE_ADS_REFRESH_TOKEN       – refresh token for the authorized user
//   GOOGLE_ADS_CUSTOMER_ID         – the account to read (digits, no dashes)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   – optional: manager (MCC) account id
// ============================================================

const GADS_API = 'https://googleads.googleapis.com';
const GADS_VERSION = 'v18';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdSpend {
  today: number;
  this_week: number;
  this_month: number;
  currency: string;
}

/** True when every credential needed for a live read is present. */
export function hasGoogleAds(): boolean {
  return (
    Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN) &&
    Boolean(process.env.GOOGLE_ADS_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_ADS_CLIENT_SECRET) &&
    Boolean(process.env.GOOGLE_ADS_REFRESH_TOKEN) &&
    Boolean(process.env.GOOGLE_ADS_CUSTOMER_ID)
  );
}

async function getAccessToken(): Promise<string> {
  const client_id = process.env.GOOGLE_ADS_CLIENT_ID!;
  const client_secret = process.env.GOOGLE_ADS_CLIENT_SECRET!;
  const refresh_token = process.env.GOOGLE_ADS_REFRESH_TOKEN!;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Google OAuth returned no access_token');
  return json.access_token;
}

interface GadsRow {
  metrics?: { costMicros?: string | number };
  customer?: { currencyCode?: string };
}

async function costFor(
  during: string,
  customerId: string,
  token: string,
): Promise<{ spend: number; currency: string }> {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!;
  const loginCustomerId = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const res = await fetch(`${GADS_API}/${GADS_VERSION}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT metrics.cost_micros, customer.currency_code FROM customer WHERE segments.date DURING ${during}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Ads API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  // searchStream returns an array of chunks, each with a `results` array.
  const payload = (await res.json()) as unknown;
  const chunks = Array.isArray(payload) ? payload : [payload];
  let micros = 0;
  let currency = 'USD';
  for (const chunk of chunks) {
    const rows = ((chunk as { results?: GadsRow[] }).results ?? []);
    for (const r of rows) {
      micros += Number(r.metrics?.costMicros ?? 0);
      if (r.customer?.currencyCode) currency = r.customer.currencyCode;
    }
  }
  return { spend: micros / 1_000_000, currency };
}

export async function fetchGoogleAdSpend(): Promise<GoogleAdSpend> {
  if (!hasGoogleAds()) throw new Error('Google Ads env vars not set');
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/\D/g, '');
  const token = await getAccessToken();

  const [today, week, month] = await Promise.all([
    costFor('TODAY', customerId, token),
    costFor('THIS_WEEK_SUN_TODAY', customerId, token),
    costFor('THIS_MONTH', customerId, token),
  ]);

  return {
    today: today.spend,
    this_week: week.spend,
    this_month: month.spend,
    currency: month.currency,
  };
}
