'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';

interface Campaign {
  id: string;
  date: string;
  status: string;
  daily_theme: string | null;
  product_sku: string | null;
  category: string | null;
  updated_at?: string | null;
  error_message: string | null;
  marketing_content?: Array<{
    video_url: string | null;
    video_status: string;
    facebook_post: string | null;
    facebook_post_id: string | null;
    instagram_caption: string | null;
    instagram_post_id: string | null;
    youtube_title: string | null;
    youtube_description: string | null;
    youtube_script: string | null;
    youtube_tags: string[] | null;
    youtube_video_id: string | null;
    google_ad_headlines: string[] | null;
    google_ad_descriptions: string[] | null;
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

interface DashboardData {
  campaigns: Campaign[];
  groups: Group[];
}

interface ProductOption {
  sku: string;
  name: string;
  category: string | null;
  sell_price: number | null;
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

const STATUS_DETAIL: Record<string, string> = {
  researching: 'Buscando tendencias, noticias y grupos relevantes en Facebook (Serper + Claude). ~20-40 seg.',
  generating: 'Claude está escribiendo el post de Facebook, caption de Instagram, script de YouTube y anuncios de Google. ~20-40 seg.',
  creating_video: 'HeyGen está renderizando el video con el avatar y la voz. 3-10 min — puedes cerrar esta página y volver.',
  pending_approval: 'El contenido está listo. Revisa antes de publicar.',
  publishing: 'Subiendo a Facebook, Instagram y YouTube...',
  published: 'Publicado en todas las plataformas configuradas.',
  rejected: 'Cancelaste esta campaña. Regenera para crear una nueva versión.',
  failed: 'La pipeline falló — revisa el mensaje de error.',
};

const PIPELINE_STEPS: Array<{ id: string; label: string }> = [
  { id: 'researching', label: 'Investigación' },
  { id: 'generating', label: 'Contenido' },
  { id: 'creating_video', label: 'Video' },
  { id: 'pending_approval', label: 'Aprobación' },
  { id: 'published', label: 'Publicación' },
];

const CATEGORIES: Array<{ value: string; label: string; desc: string }> = [
  { value: 'producto', label: '🔌 Producto', desc: 'Destacar un producto específico' },
  { value: 'educacion', label: '📚 Educación', desc: 'Enseñar sobre energía solar' },
  { value: 'tips', label: '💡 Tips', desc: 'Consejos prácticos' },
  { value: 'instalacion', label: '🔧 Instalación', desc: 'Cómo conectar / instalar' },
  { value: 'baterias', label: '🔋 Baterías', desc: 'Foco en LiFePO4, ciclos, seguridad' },
  { value: 'apagones', label: '⚡ Apagones', desc: 'Contexto del apagón en Cuba' },
  { value: 'familia', label: '👨‍👩‍👧 Familia', desc: 'Historia humana de impacto' },
];

function humanDuration(fromIso: string | null | undefined): string {
  if (!fromIso) return '';
  const secs = Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

type ContentRow = NonNullable<Campaign['marketing_content']>[number];

function ContentPreview({ content }: { content: ContentRow }) {
  const blocks: Array<{ label: string; body: React.ReactNode }> = [];

  if (content.video_url) {
    blocks.push({
      label: '🎬 Video',
      body: (
        <video
          controls
          src={content.video_url}
          className="w-full max-h-64 rounded bg-black"
        />
      ),
    });
  }

  if (content.facebook_post) {
    blocks.push({
      label: '📘 Facebook',
      body: <p className="whitespace-pre-wrap">{content.facebook_post}</p>,
    });
  }

  if (content.instagram_caption) {
    blocks.push({
      label: '📸 Instagram',
      body: <p className="whitespace-pre-wrap">{content.instagram_caption}</p>,
    });
  }

  const ytParts: React.ReactNode[] = [];
  if (content.youtube_title) {
    ytParts.push(
      <div key="t"><span className="text-gray-500">Título: </span>{content.youtube_title}</div>
    );
  }
  if (content.youtube_description) {
    ytParts.push(
      <div key="d" className="whitespace-pre-wrap"><span className="text-gray-500">Descripción: </span>{content.youtube_description}</div>
    );
  }
  if (content.youtube_script) {
    ytParts.push(
      <div key="s" className="whitespace-pre-wrap"><span className="text-gray-500">Guión: </span>{content.youtube_script}</div>
    );
  }
  if (content.youtube_tags?.length) {
    ytParts.push(
      <div key="tags" className="flex flex-wrap gap-1 mt-1">
        {content.youtube_tags.map((t) => (
          <span key={t} className="px-2 py-0.5 rounded bg-surface-700 text-gray-400 text-[10px]">#{t}</span>
        ))}
      </div>
    );
  }
  if (ytParts.length) {
    blocks.push({ label: '▶️ YouTube', body: <div className="space-y-2">{ytParts}</div> });
  }

  const adParts: React.ReactNode[] = [];
  if (content.google_ad_headlines?.length) {
    adParts.push(
      <div key="h">
        <div className="text-gray-500 mb-1">Headlines:</div>
        <ul className="list-disc list-inside space-y-0.5">
          {content.google_ad_headlines.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      </div>
    );
  }
  if (content.google_ad_descriptions?.length) {
    adParts.push(
      <div key="d">
        <div className="text-gray-500 mb-1">Descripciones:</div>
        <ul className="list-disc list-inside space-y-0.5">
          {content.google_ad_descriptions.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      </div>
    );
  }
  if (adParts.length) {
    blocks.push({ label: '📢 Google Ads', body: <div className="space-y-2">{adParts}</div> });
  }

  if (blocks.length === 0) {
    return (
      <div className="bg-surface-800 rounded-lg p-3 text-xs text-gray-500">
        Sin contenido generado todavía.
      </div>
    );
  }

  return (
    <div className="bg-surface-800 rounded-lg divide-y divide-surface-700 max-h-96 overflow-y-auto">
      {blocks.map(({ label, body }) => (
        <div key={label} className="p-3 text-xs text-gray-300 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
            {label}
          </div>
          {body}
        </div>
      ))}
    </div>
  );
}

export default function MarketingPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [adData, setAdData] = useState<AdData | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedSku, setSelectedSku] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const togglePreview = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reload = useCallback(() => {
    Promise.all([
      fetch('/api/marketing/campaigns', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/marketing/ad-spend', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([campaigns, ads]) => {
        setData(campaigns as DashboardData);
        setAdData(ads as AdData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    fetch('/api/marketing/products', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setProducts((d.products ?? []) as ProductOption[]))
      .catch(() => setProducts([]));
  }, []);

  const today = data?.campaigns.find(
    (c) => c.date === new Date().toISOString().split('T')[0]
  );

  // Auto-poll while the daily pipeline is in-flight so the operator sees
  // research → generating → creating_video → publishing progress without manual refresh.
  const inFlight = today && ['researching', 'generating', 'creating_video', 'publishing'].includes(today.status);
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [inFlight, reload]);
  const pending = data?.campaigns.find((c) => c.status === 'pending_approval');
  const history = data?.campaigns.filter((c) => c.status === 'published').slice(0, 10) ?? [];

  async function approve(approved: boolean) {
    if (!pending) return;
    setApproving(true);
    const request = fetch('/api/marketing/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, campaign_id: pending.id }),
    });
    // Pick up the server-side status='publishing' transition so the card
    // shows the spinner while the request (up to 2 min) is still in flight.
    setTimeout(reload, 500);
    await request;
    setApproving(false);
    reload();
  }

  async function generate(options: { force?: boolean; category?: string | null; productSku?: string | null } = {}) {
    const { force = false, category, productSku = selectedSku || null } = options;
    if (force && !confirm('¿Regenerar la campaña de hoy? La versión actual se perderá.')) return;
    setGenerating(true);
    try {
      const qs = new URLSearchParams();
      if (force) qs.set('force', 'true');
      if (category) qs.set('category', category);
      if (productSku) qs.set('product_sku', productSku);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      await fetch(`/api/cron/marketing-daily${suffix}`, { cache: 'no-store' });
    } finally {
      setGenerating(false);
      reload();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Cargando...
      </div>
    );
  }

  const content0 = today?.marketing_content?.[0];

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-surface-900">
      {/* Minimal header */}
      <div className="px-6 py-3 border-b border-surface-600 bg-surface-800 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Marketing</h2>
          <p className="text-[11px] text-gray-500">
            {formatDate(new Date().toISOString().split('T')[0])}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {adData?.configured && adData.spend && adData.spend.this_week > 0 && (
            <span className="text-[11px] text-gray-500">
              Gasto semana: <span className="text-brand-400 font-semibold">${adData.spend.this_week.toFixed(2)}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => reload()}
            className="text-xs text-gray-500 hover:text-gray-300"
            title="Refrescar"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="p-6 space-y-5 max-w-3xl mx-auto w-full">

        {/* ─────────────  PRODUCT PICKER (opcional)  ───────────── */}
        {products.length > 0 && (
          <ProductPicker
            products={products}
            selected={selectedSku}
            onChange={setSelectedSku}
          />
        )}

        {/* ─────────────────  HERO  ───────────────── */}
        {!today ? (
          <CategoryLauncher onPick={(cat) => generate({ category: cat })} busy={generating} />
        ) : (
          <CampaignHero
            campaign={today}
            inFlight={!!inFlight}
            approving={approving}
            generating={generating}
            onApprove={approve}
            onRegenerate={(cat) => generate({ force: true, category: cat })}
          />
        )}

        {/* ─────────────  HISTORY  ───────────── */}
        {history.length > 0 && (
          <HistorySection
            campaigns={history}
            expanded={expanded}
            onToggle={togglePreview}
          />
        )}

        {/* ───────  AD SPEND (collapsed when zero) ─────── */}
        {adData && <AdSpendStrip data={adData} />}

        {/* ───────  FB GROUPS ─────── */}
        {data && data.groups.length > 0 && (
          <details className="card">
            <summary className="px-4 py-2.5 text-xs text-gray-400 cursor-pointer hover:bg-surface-800/50">
              Grupos de Facebook ({data.groups.length})
            </summary>
            <div className="divide-y divide-surface-700 max-h-64 overflow-y-auto">
              {data.groups.map((g) => (
                <div key={g.id} className="flex items-center justify-between px-4 py-2">
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
          </details>
        )}

        {/* ─────────────  CHANNEL / ENV STATUS  ───────────── */}
        <EnvStatusRow content={content0} />
      </div>
    </div>
  );
}

// ─────────────────  CAMPAIGN HERO  ─────────────────

function CampaignHero({
  campaign,
  inFlight,
  approving,
  generating,
  onApprove,
  onRegenerate,
}: {
  campaign: Campaign;
  inFlight: boolean;
  approving: boolean;
  generating: boolean;
  onApprove: (approved: boolean) => void;
  onRegenerate: (cat: string) => void;
}) {
  const content = campaign.marketing_content?.[0];
  const currentIdx = PIPELINE_STEPS.findIndex((s) => s.id === campaign.status);
  const terminal = campaign.status === 'failed' || campaign.status === 'rejected';
  const readyToApprove = campaign.status === 'pending_approval';
  const categoryLabel = campaign.category
    ? CATEGORIES.find((c) => c.value === campaign.category)?.label
    : null;

  return (
    <div className="card overflow-hidden ring-1 ring-surface-600">
      {/* Pipeline strip */}
      <div className="h-1 flex">
        {PIPELINE_STEPS.map((step, i) => {
          const done = !terminal && currentIdx >= 0 && i < currentIdx;
          const active = !terminal && currentIdx >= 0 && i === currentIdx;
          const cls = terminal
            ? 'bg-red-800/40'
            : done
            ? 'bg-green-600'
            : active
            ? 'bg-brand-500 animate-pulse'
            : 'bg-surface-700';
          return <div key={step.id} className={`flex-1 ${cls}`} />;
        })}
      </div>

      {/* Meta row */}
      <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm">
            {inFlight ? (
              <svg className="animate-spin w-4 h-4 text-brand-500 shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : (
              <span>{STATUS_EMOJI[campaign.status]}</span>
            )}
            <span className="font-medium text-gray-200">{STATUS_LABEL[campaign.status] ?? campaign.status}</span>
            {inFlight && campaign.updated_at && (
              <span className="text-[11px] text-gray-500">· {humanDuration(campaign.updated_at)}</span>
            )}
          </p>
          {campaign.daily_theme && (
            <p className="text-lg text-gray-100 font-semibold mt-1 leading-snug">{campaign.daily_theme}</p>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-[11px]">
            {categoryLabel && (
              <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-300">{categoryLabel}</span>
            )}
            {campaign.product_sku && (
              <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-300">{campaign.product_sku}</span>
            )}
          </div>
        </div>
      </div>

      {/* Pipeline hint */}
      {STATUS_DETAIL[campaign.status] && (
        <p className="px-5 pb-3 text-xs text-gray-500 italic border-b border-surface-700">
          {STATUS_DETAIL[campaign.status]}
        </p>
      )}

      {campaign.error_message && (
        <p className="mx-5 mt-3 text-xs text-red-300 bg-red-950/40 rounded p-2">
          ⚠️ {campaign.error_message}
        </p>
      )}

      {/* Channel chips */}
      {content && <ChannelStatusChips content={content} />}

      {/* Rendered FB-style preview (always visible, no toggle) */}
      {content && <FacebookPreview content={content} />}

      {/* Primary CTA */}
      {readyToApprove && (
        <div className="px-5 py-4 bg-surface-800/60 border-t border-surface-700 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => onApprove(true)}
              disabled={approving}
              className="flex-1 py-3 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold text-sm transition-colors disabled:opacity-50"
            >
              {approving ? 'Publicando...' : '✅ Publicar en todos los canales'}
            </button>
            <button
              onClick={() => onApprove(false)}
              disabled={approving}
              className="px-4 py-3 rounded-lg bg-surface-700 hover:bg-surface-600 text-gray-300 text-sm transition-colors disabled:opacity-50"
              title="Rechazar — no se publicará"
            >
              Rechazar
            </button>
          </div>
          <p className="text-[11px] text-gray-500 text-center">
            También puedes responder <strong className="text-gray-400">SI</strong> / <strong className="text-gray-400">NO</strong> por WhatsApp
          </p>
        </div>
      )}

      {/* Secondary: regenerate tiles (always visible so you can redirect any time) */}
      <div className="px-5 py-4 border-t border-surface-700">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">
          {inFlight ? 'Cancelar y regenerar como' : readyToApprove ? 'O regenerar como' : 'Regenerar como'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {CATEGORIES.map((c) => {
            const current = campaign.category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => onRegenerate(c.value)}
                disabled={generating}
                className={`px-2 py-1.5 rounded text-[11px] transition-colors disabled:opacity-50 ${
                  current
                    ? 'bg-brand-600/20 border border-brand-500/50 text-brand-200'
                    : 'bg-surface-700 hover:bg-surface-600 text-gray-300'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProductPicker({
  products,
  selected,
  onChange,
}: {
  products: ProductOption[];
  selected: string;
  onChange: (sku: string) => void;
}) {
  return (
    <div className="card px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-300 font-medium">Producto para la próxima campaña</p>
        <p className="text-[11px] text-gray-500">
          Opcional. Si no eliges, el sistema rota un producto por día automáticamente.
        </p>
      </div>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1.5 rounded bg-surface-800 border border-surface-600 text-xs text-gray-200 min-w-[220px] focus:outline-none focus:border-brand-500"
      >
        <option value="">Rotación automática (por día)</option>
        {products.map((p) => (
          <option key={p.sku} value={p.sku}>
            {p.sku} — {p.name}
            {p.sell_price ? ` · $${Number(p.sell_price).toFixed(0)}` : ''}
          </option>
        ))}
      </select>
      {selected && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-[11px] text-gray-500 hover:text-gray-300 underline"
          title="Volver a rotación automática"
        >
          limpiar
        </button>
      )}
    </div>
  );
}

function CategoryLauncher({
  onPick,
  busy,
}: {
  onPick: (cat: string) => void;
  busy: boolean;
}) {
  return (
    <div className="card p-6">
      <div className="text-center mb-5">
        <p className="text-3xl mb-2">📭</p>
        <p className="text-sm text-gray-300">Aún no hay campaña para hoy</p>
        <p className="text-[11px] text-gray-500 mt-1">Elige un ángulo para generar el contenido:</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onPick(c.value)}
            disabled={busy}
            className="text-left p-3 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-600 hover:border-brand-500/50 transition-colors disabled:opacity-50"
          >
            <p className="text-sm font-medium text-gray-200">{c.label}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{c.desc}</p>
          </button>
        ))}
      </div>
      {busy && (
        <p className="text-xs text-brand-400 mt-4 text-center flex items-center justify-center gap-2">
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Iniciando pipeline...
        </p>
      )}
    </div>
  );
}

function ChannelStatusChips({ content }: { content: ContentRow }) {
  const channels: Array<{
    label: string;
    ready: boolean | null; // true ready to post, false not-ready, null = skipped by config
    published: boolean;
    note?: string;
  }> = [
    {
      label: '📘 Facebook',
      ready: !!content.facebook_post,
      published: !!content.facebook_post_id,
    },
    {
      label: '📸 Instagram',
      ready: !!content.instagram_caption && !!content.video_url,
      published: !!content.instagram_post_id,
      note: !content.video_url ? 'necesita video' : undefined,
    },
    {
      label: '▶️ YouTube',
      ready: !!content.youtube_title && !!content.video_url,
      published: !!content.youtube_video_id,
      note: !content.video_url ? 'necesita video' : undefined,
    },
    {
      label: '📢 Google Ads',
      ready: !!(content.google_ad_headlines && content.google_ad_headlines.length > 0),
      published: false,
      note: 'publicador pendiente',
    },
  ];
  return (
    <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-surface-700">
      {channels.map((ch) => {
        let state: 'published' | 'ready' | 'skip';
        if (ch.published) state = 'published';
        else if (ch.ready) state = 'ready';
        else state = 'skip';
        const cls =
          state === 'published'
            ? 'bg-green-900/40 text-green-300 border-green-700/40'
            : state === 'ready'
            ? 'bg-brand-900/40 text-brand-200 border-brand-700/40'
            : 'bg-surface-800 text-gray-500 border-surface-600';
        const icon = state === 'published' ? '✅' : state === 'ready' ? '•' : '○';
        return (
          <span
            key={ch.label}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] ${cls}`}
          >
            <span>{icon}</span>
            <span>{ch.label}</span>
            {ch.note && <span className="text-gray-500">· {ch.note}</span>}
          </span>
        );
      })}
    </div>
  );
}

function FacebookPreview({ content }: { content: ContentRow }) {
  const body = content.facebook_post ?? content.instagram_caption ?? '';
  const lines = body.split('\n');
  return (
    <div className="bg-surface-800/50 px-5 py-4 border-b border-surface-700">
      <div className="bg-white text-gray-900 rounded-lg p-4 shadow-sm max-w-xl mx-auto">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-9 h-9 rounded-full bg-orange-500 flex items-center justify-center text-white text-sm font-bold">
            O
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 flex items-center gap-1">
              Oiikon <span className="text-blue-600 text-xs">✓</span>
            </p>
            <p className="text-[11px] text-gray-500">Vista previa · Público</p>
          </div>
        </div>
        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
          {lines.map((l, i) => (
            <p key={i} className="min-h-[1rem]">
              {l}
            </p>
          ))}
        </div>
        {content.video_url && (
          <video controls src={content.video_url} className="mt-3 w-full rounded" />
        )}
      </div>
    </div>
  );
}

// ─────────────────  HISTORY  ─────────────────

function HistorySection({
  campaigns,
  expanded,
  onToggle,
}: {
  campaigns: Campaign[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <section>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Publicadas</p>
      <div className="card divide-y divide-surface-700">
        {campaigns.map((c) => {
          const perf = c.marketing_performance?.[0];
          const content = c.marketing_content?.[0];
          const engagement = perf
            ? perf.facebook_likes + perf.facebook_comments * 3 + perf.facebook_shares * 5 + perf.instagram_likes
            : null;
          const isOpen = expanded.has(c.id);
          const canExpand = !!content;
          return (
            <div key={c.id}>
              <button
                type="button"
                onClick={() => canExpand && onToggle(c.id)}
                disabled={!canExpand}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-800/50 transition-colors disabled:hover:bg-transparent disabled:cursor-default"
              >
                <div className="min-w-0 flex items-center gap-2 flex-1">
                  {canExpand && (
                    <span className="text-xs text-gray-500 shrink-0">{isOpen ? '▼' : '▶'}</span>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm text-gray-200 truncate">{c.daily_theme ?? c.product_sku}</p>
                    <p className="text-[11px] text-gray-600">
                      {new Date(c.date + 'T12:00:00').toLocaleDateString('es-ES', {
                        day: 'numeric',
                        month: 'short',
                      })}
                      {c.category && ` · ${CATEGORIES.find((x) => x.value === c.category)?.label ?? c.category}`}
                      {content?.facebook_post_id && ' · 📘'}
                      {content?.instagram_post_id && ' · 📸'}
                      {content?.youtube_video_id && ' · ▶️'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3">
                  {perf && perf.facebook_likes > 0 && (
                    <span className="text-[11px] text-gray-400">❤️ {perf.facebook_likes}</span>
                  )}
                  {perf && perf.youtube_views > 0 && (
                    <span className="text-[11px] text-gray-400">👁️ {perf.youtube_views}</span>
                  )}
                  {engagement !== null && engagement > 0 && (
                    <span
                      className={`text-[11px] font-medium ${
                        engagement > 50
                          ? 'text-green-400'
                          : engagement > 20
                          ? 'text-yellow-400'
                          : 'text-gray-500'
                      }`}
                    >
                      {engagement} pts
                    </span>
                  )}
                  {content?.youtube_video_id && (
                    <a
                      href={`https://youtube.com/watch?v=${content.youtube_video_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] text-brand-400 hover:underline"
                    >
                      YT →
                    </a>
                  )}
                </div>
              </button>
              {isOpen && content && (
                <div className="px-4 pb-3">
                  <ContentPreview content={content} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────  AD SPEND  ─────────────────

function AdSpendStrip({ data }: { data: AdData }) {
  if (!data.configured) {
    return (
      <div className="card p-3 border border-dashed border-surface-600 flex items-center gap-2">
        <span className="text-[11px] text-gray-500">
          Gasto en anuncios no configurado —
          <span className="font-mono text-gray-400 ml-1">META_AD_ACCOUNT_ID</span>
        </span>
      </div>
    );
  }
  if (!data.spend) return null;
  const allZero =
    data.spend.today === 0 &&
    data.spend.yesterday === 0 &&
    data.spend.this_week === 0 &&
    data.spend.this_month === 0;

  return (
    <details className="card" open={!allZero}>
      <summary className="px-4 py-2.5 cursor-pointer text-xs text-gray-400 hover:bg-surface-800/50 flex items-center justify-between">
        <span>Gasto en Anuncios (Facebook Ads)</span>
        <span className="text-gray-500">
          {allZero
            ? 'Sin gasto este mes'
            : `Mes: $${data.spend.this_month.toFixed(2)} ${data.spend.currency}`}
        </span>
      </summary>
      <div className="border-t border-surface-700 grid grid-cols-4 divide-x divide-surface-700">
        {[
          { label: 'Hoy', value: data.spend.today },
          { label: 'Ayer', value: data.spend.yesterday },
          { label: 'Semana', value: data.spend.this_week },
          { label: 'Mes', value: data.spend.this_month },
        ].map(({ label, value }) => (
          <div key={label} className="p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
            <p className="text-sm font-semibold text-gray-200">${value.toFixed(2)}</p>
          </div>
        ))}
      </div>
      {data.campaigns.length > 0 && (
        <div className="divide-y divide-surface-700 border-t border-surface-700">
          {data.campaigns
            .filter((c) => c.spend > 0 || c.status === 'ACTIVE')
            .map((c) => (
              <div key={c.id} className="flex items-center justify-between px-4 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-gray-300 truncate">{c.name}</p>
                  <p className="text-[11px] text-gray-600">
                    {c.impressions.toLocaleString()} imp ·{' '}
                    {c.ctr > 0 ? `${c.ctr.toFixed(2)}% CTR` : '—'}
                    {c.daily_budget ? ` · $${c.daily_budget}/día` : ''}
                  </p>
                </div>
                <p className="text-sm font-semibold text-gray-200 ml-3">${c.spend.toFixed(2)}</p>
              </div>
            ))}
        </div>
      )}
    </details>
  );
}

// ─────────────────  ENV STATUS  ─────────────────

function EnvStatusRow({ content }: { content?: ContentRow }) {
  // We can't read env from the client, but we can infer from content fields
  // whether each integration produced output today.
  const checks = [
    { label: 'Meta Page', key: 'facebook_post_id', got: !!content?.facebook_post_id, needs: 'META_PAGE_ID / META_PAGE_ACCESS_TOKEN' },
    { label: 'Instagram', key: 'instagram_post_id', got: !!content?.instagram_post_id, needs: 'META_IG_ACCOUNT_ID' },
    { label: 'YouTube', key: 'youtube_video_id', got: !!content?.youtube_video_id, needs: 'YOUTUBE_CLIENT_*' },
    { label: 'HeyGen', key: 'video_url', got: !!content?.video_url, needs: 'HEYGEN_API_KEY / AVATAR_ID / VOICE_ID' },
  ];
  return (
    <details className="card">
      <summary className="px-4 py-2.5 cursor-pointer text-xs text-gray-500 hover:bg-surface-800/50">
        Estado de integraciones
      </summary>
      <div className="divide-y divide-surface-700 border-t border-surface-700">
        {checks.map((c) => (
          <div key={c.key} className="flex items-center justify-between px-4 py-2">
            <div>
              <p className="text-xs text-gray-300">{c.label}</p>
              <p className="text-[10px] font-mono text-gray-600">{c.needs}</p>
            </div>
            <span className={`text-[11px] ${c.got ? 'text-green-400' : 'text-gray-500'}`}>
              {c.got ? '✅ activo' : '○ sin datos hoy'}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
