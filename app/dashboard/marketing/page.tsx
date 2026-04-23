'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';

interface Campaign {
  id: string;
  date: string;
  status: string;
  daily_theme: string | null;
  product_sku: string | null;
  error_message: string | null;
  marketing_content?: Array<{
    video_url: string | null;
    video_status: string;
    youtube_title: string | null;
    facebook_post: string | null;
    facebook_post_id: string | null;
    youtube_video_id: string | null;
    published_at: string | null;
  }>;
  marketing_performance?: Array<{
    facebook_likes: number;
    facebook_comments: number;
    facebook_shares: number;
    youtube_views: number;
    instagram_likes: number;
  }>;
}

interface Group {
  id: string;
  name: string;
  url: string;
  last_posted_at: string | null;
}

interface AdSpend {
  today: number;
  yesterday: number;
  this_week: number;
  this_month: number;
  currency: string;
}

interface CampaignSpend {
  id: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  cpc: number;
  ctr: number;
  daily_budget: number | null;
}

interface AdData {
  configured: boolean;
  message?: string;
  spend: AdSpend | null;
  campaigns: CampaignSpend[];
}

interface GA4Data {
  configured: boolean;
  error?: string;
  last7Days?: { sessions: number; users: number; pageViews: number; bounceRate: number };
  last30Days?: { sessions: number; users: number; pageViews: number };
  topPages?: Array<{ page: string; views: number }>;
  trafficSources?: Array<{ source: string; sessions: number }>;
  sessionsByDay?: Array<{ date: string; sessions: number }>;
}

interface DashboardData {
  campaigns: Campaign[];
  groups: Group[];
}

const STATUS_EMOJI: Record<string, string> = {
  researching: '🔍',
  generating: '✍️',
  creating_video: '🎬',
  pending_approval: '⏳',
  publishing: '📤',
  published: '✅',
  rejected: '❌',
  failed: '⚠️',
};

const STATUS_LABEL: Record<string, string> = {
  researching: 'Investigando tendencias',
  generating: 'Creando contenido',
  creating_video: 'Generando video con IA',
  pending_approval: 'Listo — esperando tu aprobación',
  publishing: 'Publicando...',
  published: 'Publicado',
  rejected: 'Cancelado',
  failed: 'Error',
};

function formatDate(dateStr: string) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export default function MarketingPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [adData, setAdData] = useState<AdData | null>(null);
  const [ga4, setGa4] = useState<GA4Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<Campaign | null>(null);

  const reload = useCallback(() => {
    Promise.all([
      fetch('/api/marketing/campaigns', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/marketing/ad-spend', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/marketing/analytics', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ])
      .then(([campaigns, ads, analytics]) => {
        setData(campaigns as DashboardData);
        setAdData(ads as AdData);
        setGa4(analytics as GA4Data | null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const today = data?.campaigns.find(
    (c) => c.date === new Date().toISOString().split('T')[0]
  );
  const pending = data?.campaigns.find((c) => c.status === 'pending_approval');
  const history = data?.campaigns.filter((c) => c.status === 'published').slice(0, 10) ?? [];

  async function approve(approved: boolean) {
    if (!pending) return;
    setApproving(true);
    await fetch('/api/marketing/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, campaign_id: pending.id }),
    });
    setApproving(false);
    reload();
  }

  async function generate() {
    setGenerating(true);
    await fetch('/api/cron/marketing-daily');
    setTimeout(() => { setGenerating(false); reload(); }, 3000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Cargando...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-surface-900">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-600 bg-surface-800 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Marketing Oiikon</h2>
          <p className="text-xs text-gray-500">Facebook · Instagram · YouTube · Google Ads</p>
        </div>
        {!today && (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {generating ? 'Generando...' : '▶ Generar hoy'}
          </button>
        )}
      </div>

      <div className="p-6 space-y-6 max-w-2xl mx-auto w-full">

        {/* ── AD SPEND ────────────────────────────────────────── */}
        {adData?.configured && adData.spend && (
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
              Gasto en Anuncios (Facebook Ads)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Hoy', value: adData.spend.today },
                { label: 'Ayer', value: adData.spend.yesterday },
                { label: 'Esta semana', value: adData.spend.this_week },
                { label: 'Este mes', value: adData.spend.this_month },
              ].map(({ label, value }) => (
                <div key={label} className="card p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className="text-2xl font-bold text-brand-400">
                    ${value.toFixed(2)}
                  </p>
                  <p className="text-xs text-gray-600">{adData.spend!.currency}</p>
                </div>
              ))}
            </div>

            {/* Campaign breakdown */}
            {adData.campaigns.length > 0 && (
              <div className="card mt-3 divide-y divide-surface-700">
                {adData.campaigns
                  .filter((c) => c.spend > 0 || c.status === 'ACTIVE')
                  .map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-300 truncate">{c.name}</p>
                        <p className="text-xs text-gray-600">
                          {c.impressions.toLocaleString()} imp ·{' '}
                          {c.ctr > 0 ? `${c.ctr.toFixed(2)}% CTR` : '—'}
                          {c.daily_budget ? ` · Budget $${c.daily_budget}/día` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 ml-4 text-right">
                        <p className="text-sm font-semibold text-gray-200">
                          ${c.spend.toFixed(2)}
                        </p>
                        {c.cpc > 0 && (
                          <p className="text-xs text-gray-500">${c.cpc.toFixed(2)}/clic</p>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>
        )}

        {adData && !adData.configured && (
          <section>
            <div className="card p-4 border border-dashed border-surface-600">
              <p className="text-xs text-gray-500 font-medium mb-1">Gasto en Anuncios</p>
              <p className="text-xs text-gray-600">
                Agrega <span className="font-mono text-gray-400">META_AD_ACCOUNT_ID</span> a las variables de entorno de Vercel para ver tu gasto.
              </p>
            </div>
          </section>
        )}

        {/* ── GOOGLE ANALYTICS ────────────────────────────────── */}
        {ga4?.configured && !ga4.error && ga4.last7Days && (
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
              Sitio Web — oiikon.com (GA4)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Usuarios (7d)', value: ga4.last7Days.users.toLocaleString() },
                { label: 'Sesiones (7d)', value: ga4.last7Days.sessions.toLocaleString() },
                { label: 'Páginas vistas (7d)', value: ga4.last7Days.pageViews.toLocaleString() },
                { label: 'Rebote', value: `${ga4.last7Days.bounceRate}%` },
              ].map(({ label, value }) => (
                <div key={label} className="card p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className="text-xl font-bold text-gray-100">{value}</p>
                </div>
              ))}
            </div>

            {/* Traffic sources */}
            {ga4.trafficSources && ga4.trafficSources.length > 0 && (
              <div className="card mt-3 p-4">
                <p className="text-xs text-gray-500 mb-3">Fuentes de tráfico (30 días)</p>
                <div className="space-y-2">
                  {ga4.trafficSources.slice(0, 6).map((s) => {
                    const max = ga4.trafficSources![0].sessions;
                    const pct = Math.round((s.sessions / max) * 100);
                    return (
                      <div key={s.source}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-300">{s.source}</span>
                          <span className="text-gray-500">{s.sessions.toLocaleString()}</span>
                        </div>
                        <div className="h-1.5 bg-surface-600 rounded-full">
                          <div className="h-full bg-brand-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Top pages */}
            {ga4.topPages && ga4.topPages.length > 0 && (
              <div className="card mt-3 divide-y divide-surface-700">
                <p className="text-xs text-gray-500 px-4 py-2">Páginas más visitadas (30 días)</p>
                {ga4.topPages.slice(0, 5).map((p) => (
                  <div key={p.page} className="flex justify-between px-4 py-2">
                    <span className="text-xs text-gray-400 truncate max-w-xs">{p.page}</span>
                    <span className="text-xs text-gray-500 shrink-0 ml-4">{p.views.toLocaleString()} vistas</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── TODAY'S STATUS ─────────────────────────────────── */}
        <section>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Hoy</p>

          {!today ? (
            <div className="card p-6 text-center">
              <p className="text-2xl mb-2">📭</p>
              <p className="text-sm text-gray-400">No hay campaña para hoy.</p>
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="mt-4 px-6 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {generating ? 'Generando...' : 'Crear campaña ahora'}
              </button>
            </div>
          ) : (
            <div className="card p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-lg font-semibold text-gray-100">
                    {STATUS_EMOJI[today.status]} {STATUS_LABEL[today.status] ?? today.status}
                  </p>
                  {today.daily_theme && (
                    <p className="text-sm text-gray-400 mt-1">"{today.daily_theme}"</p>
                  )}
                  {today.product_sku && (
                    <p className="text-xs text-gray-600 mt-0.5">Producto: {today.product_sku}</p>
                  )}
                </div>
                <span className="text-xs text-gray-600">
                  {formatDate(today.date)}
                </span>
              </div>

              {/* Progress bar for in-flight steps */}
              {['researching', 'generating', 'creating_video'].includes(today.status) && (
                <div className="space-y-1">
                  {['researching', 'generating', 'creating_video'].map((step) => {
                    const steps = ['researching', 'generating', 'creating_video'];
                    const currentIdx = steps.indexOf(today.status);
                    const stepIdx = steps.indexOf(step);
                    const done = stepIdx < currentIdx;
                    const active = stepIdx === currentIdx;
                    return (
                      <div key={step} className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${done ? 'bg-green-500' : active ? 'bg-brand-500 animate-pulse' : 'bg-surface-600'}`} />
                        <span className={`text-xs ${active ? 'text-gray-200' : done ? 'text-gray-500 line-through' : 'text-gray-600'}`}>
                          {STATUS_LABEL[step]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {today.error_message && (
                <p className="text-xs text-red-400 bg-red-950/30 rounded p-2">
                  ⚠️ {today.error_message}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── APPROVAL ───────────────────────────────────────── */}
        {pending && (
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
              Acción requerida
            </p>
            <div className="card p-5 space-y-4 ring-1 ring-brand-500/40">
              <div>
                <p className="text-sm font-semibold text-gray-100 mb-1">
                  La campaña está lista para publicar
                </p>
                <p className="text-xs text-gray-400">
                  Tema: <span className="text-gray-300">{pending.daily_theme}</span>
                  {' · '}Producto: <span className="text-gray-300">{pending.product_sku}</span>
                </p>
                {pending.marketing_content?.[0]?.video_url && (
                  <p className="text-xs mt-1">
                    <span className="text-green-400">✅ Video listo</span>
                  </p>
                )}
              </div>

              {/* Preview button */}
              {pending.marketing_content?.[0]?.facebook_post && (
                <button
                  type="button"
                  onClick={() => setPreview(preview?.id === pending.id ? null : pending)}
                  className="text-xs text-brand-400 hover:text-brand-300"
                >
                  {preview?.id === pending.id ? 'Ocultar preview ▲' : 'Ver contenido ▼'}
                </button>
              )}

              {preview?.id === pending.id && pending.marketing_content?.[0] && (
                <div className="bg-surface-800 rounded-lg p-3 text-xs text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {pending.marketing_content[0].facebook_post}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => approve(true)}
                  disabled={approving}
                  className="flex-1 py-3 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold text-sm transition-colors disabled:opacity-50"
                >
                  {approving ? 'Publicando...' : '✅ Publicar ahora'}
                </button>
                <button
                  onClick={() => approve(false)}
                  disabled={approving}
                  className="px-4 py-3 rounded-lg bg-surface-700 hover:bg-surface-600 text-gray-400 text-sm transition-colors disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>

              <p className="text-xs text-gray-600 text-center">
                También puedes responder <strong className="text-gray-400">SI</strong> o <strong className="text-gray-400">NO</strong> por WhatsApp
              </p>
            </div>
          </section>
        )}

        {/* ── HISTORY ────────────────────────────────────────── */}
        {history.length > 0 && (
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
              Campañas publicadas
            </p>
            <div className="card divide-y divide-surface-700">
              {history.map((c) => {
                const perf = c.marketing_performance?.[0];
                const content = c.marketing_content?.[0];
                const engagement = perf
                  ? perf.facebook_likes + perf.facebook_comments * 3 +
                    perf.facebook_shares * 5 + perf.instagram_likes
                  : null;
                return (
                  <div key={c.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-300 truncate">
                        {c.daily_theme ?? c.product_sku}
                      </p>
                      <p className="text-xs text-gray-600">
                        {new Date(c.date + 'T12:00:00').toLocaleDateString('es-ES', {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0 ml-4">
                      {perf && (
                        <div className="hidden sm:flex gap-3 text-xs text-gray-500">
                          <span>❤️ {perf.facebook_likes}</span>
                          <span>👁️ {perf.youtube_views}</span>
                        </div>
                      )}
                      {engagement !== null && (
                        <span className={`text-xs font-medium ${engagement > 50 ? 'text-green-400' : engagement > 20 ? 'text-yellow-400' : 'text-gray-500'}`}>
                          {engagement} pts
                        </span>
                      )}
                      {content?.youtube_video_id && (
                        <a
                          href={`https://youtube.com/watch?v=${content.youtube_video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-brand-400 hover:underline"
                        >
                          YT →
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── FACEBOOK GROUPS ────────────────────────────────── */}
        {data && data.groups.length > 0 && (
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
              Grupos de Facebook ({data.groups.length})
            </p>
            <div className="card divide-y divide-surface-700 max-h-64 overflow-y-auto">
              {data.groups.map((g) => (
                <div key={g.id} className="flex items-center justify-between px-4 py-2.5">
                  <a
                    href={g.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-300 hover:text-brand-400 truncate max-w-xs"
                  >
                    {g.name}
                  </a>
                  <span className="text-xs text-gray-600 shrink-0 ml-3">
                    {g.last_posted_at
                      ? new Date(g.last_posted_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
                      : 'Sin post'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── ENV REMINDER ────────────────────────────────────── */}
        <section className="card p-4 bg-surface-800/50 space-y-1">
          <p className="text-xs text-gray-500 font-medium">Variables de entorno necesarias</p>
          {[
            'SERPER_API_KEY', 'HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID', 'HEYGEN_VOICE_ID',
            'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_IG_ACCOUNT_ID',
            'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN',
          ].map((v) => (
            <p key={v} className="text-xs font-mono text-gray-600">{v}</p>
          ))}
        </section>
      </div>
    </div>
  );
}
