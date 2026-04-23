/**
 * Google Analytics 4 — Data API
 * Property ID: 518108184 (oiikon.com)
 *
 * Shows: sessions, users, page views, top pages, traffic sources,
 * and conversions — all fed into the marketing dashboard.
 */

const GA4_API = 'https://analyticsdata.googleapis.com/v1beta';
const PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? '518108184';

async function getAccessToken(): Promise<string> {
  const clientEmail = process.env.GA4_CLIENT_EMAIL;
  const privateKey = process.env.GA4_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('GA4_CLIENT_EMAIL or GA4_PRIVATE_KEY not set');
  }

  // Build JWT for Google service account auth
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');

  // Sign with RS256 using the service account private key
  const { createSign } = await import('node:crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');

  const jwt = `${header}.${payload}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`GA4 token error: ${err.slice(0, 200)}`);
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

async function runReport(
  token: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GA4_API}/properties/${PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 report error (${res.status}): ${err.slice(0, 200)}`);
  }

  return res.json() as Promise<Record<string, unknown>>;
}

function extractRows(
  report: Record<string, unknown>
): Array<Record<string, string>> {
  const rows = (report.rows as Array<{
    dimensionValues?: Array<{ value: string }>;
    metricValues?: Array<{ value: string }>;
  }>) ?? [];

  const dimHeaders = ((report.dimensionHeaders as Array<{ name: string }>) ?? []).map(
    (h) => h.name
  );
  const metHeaders = ((report.metricHeaders as Array<{ name: string }>) ?? []).map(
    (h) => h.name
  );

  return rows.map((row) => {
    const obj: Record<string, string> = {};
    (row.dimensionValues ?? []).forEach((v, i) => {
      obj[dimHeaders[i]] = v.value;
    });
    (row.metricValues ?? []).forEach((v, i) => {
      obj[metHeaders[i]] = v.value;
    });
    return obj;
  });
}

export interface GA4Summary {
  last7Days: {
    sessions: number;
    users: number;
    pageViews: number;
    bounceRate: number;
    avgSessionDuration: number;
  };
  last30Days: {
    sessions: number;
    users: number;
    pageViews: number;
  };
  topPages: Array<{ page: string; views: number }>;
  trafficSources: Array<{ source: string; sessions: number }>;
  sessionsByDay: Array<{ date: string; sessions: number }>;
}

export async function fetchGA4Summary(): Promise<GA4Summary> {
  const token = await getAccessToken();

  const [overview7, overview30, topPages, sources, byDay] = await Promise.all([
    // Last 7 days overview
    runReport(token, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
    }),

    // Last 30 days overview
    runReport(token, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'screenPageViews' },
      ],
    }),

    // Top pages (last 30 days)
    runReport(token, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
    }),

    // Traffic sources (last 30 days)
    runReport(token, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 8,
    }),

    // Sessions by day (last 14 days)
    runReport(token, {
      dateRanges: [{ startDate: '14daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
  ]);

  // Parse overview 7d
  const tot7 = (
    (overview7.totals as Array<{ metricValues: Array<{ value: string }> }>) ?? []
  )[0]?.metricValues ?? [];
  const n = (i: number) => parseFloat(tot7[i]?.value ?? '0');

  // Parse overview 30d
  const tot30 = (
    (overview30.totals as Array<{ metricValues: Array<{ value: string }> }>) ?? []
  )[0]?.metricValues ?? [];
  const m = (i: number) => parseFloat(tot30[i]?.value ?? '0');

  return {
    last7Days: {
      sessions: n(0),
      users: n(1),
      pageViews: n(2),
      bounceRate: Math.round(n(3) * 100),
      avgSessionDuration: Math.round(n(4)),
    },
    last30Days: {
      sessions: m(0),
      users: m(1),
      pageViews: m(2),
    },
    topPages: extractRows(topPages).map((r) => ({
      page: r.pagePath ?? '/',
      views: parseInt(r.screenPageViews ?? '0'),
    })),
    trafficSources: extractRows(sources).map((r) => ({
      source: r.sessionDefaultChannelGroup ?? 'Direct',
      sessions: parseInt(r.sessions ?? '0'),
    })),
    sessionsByDay: extractRows(byDay).map((r) => ({
      date: r.date ?? '',
      sessions: parseInt(r.sessions ?? '0'),
    })),
  };
}
