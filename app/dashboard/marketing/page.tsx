'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from 'react';

interface Campaign {
  id: string;
  date: string;
  language?: string | null;
  status: string;
  daily_theme: string | null;
  product_sku: string | null;
  category: string | null;
  updated_at?: string | null;
  created_at?: string | null;
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

interface Product {
  sku: string;
  name: string;
  category: string | null;
  sell_price: number | null;
  battery_capacity_wh: number | null;
  output_watts: number | null;
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
  { value: 'apagones', label: '⚡ Apagones', desc: 'Apagones y huracanes en EE.UU.' },
  { value: 'familia', label: '🏠 Hogar', desc: 'Historia humana — cualquier hogar US' },
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

// Always tells the operator where the video stands — generating / ready / error
// / skipped — instead of silently rendering a <video> that spins forever on a
// dead or missing URL (the "I can't see the video" confusion).
function VideoStatusChip({ content, className = '' }: { content: ContentRow; className?: string }) {
  const vs = content.video_status;
  if ((vs === 'processing' || vs === 'pending') && !content.video_url) {
    return (
      <div className={`flex items-center gap-2 rounded bg-surface-800/70 ring-1 ring-surface-600 p-2.5 text-xs text-brand-200 ${className}`}>
        <svg className="animate-spin w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        🎬 Generando video… puede tardar unos minutos. La página se actualiza sola.
      </div>
    );
  }
  if (vs === 'failed') {
    return (
      <p className={`rounded bg-red-950/40 ring-1 ring-red-900/40 p-2.5 text-xs text-red-300 ${className}`}>
        🚨 No se pudo generar el video. Publica «📝 Solo texto» o regenera el video.
      </p>
    );
  }
  if (vs === 'skipped') {
    return <p className={`text-[11px] text-gray-500 ${className}`}>📷 Sin video (campaña de imagen).</p>;
  }
  if (vs === 'ready' && content.video_url) {
    return <p className={`text-[11px] text-green-400 ${className}`}>✅ Video listo</p>;
  }
  return null;
}

function ContentPreview({ content }: { content: ContentRow }) {
  const blocks: Array<{ label: string; body: React.ReactNode }> = [];

  if (content.video_url && content.video_status !== 'failed') {
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
  } else if (content.video_status && content.video_status !== 'ready') {
    blocks.push({ label: '🎬 Video', body: <VideoStatusChip content={content} /> });
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
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Which specific campaign card is mid-action — so a busy label (e.g.
  // "Publicando…") only shows on the card you clicked, not every card.
  const [busyId, setBusyId] = useState<string | null>(null);
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
      fetch('/api/marketing/products', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([campaigns, ads, prods]) => {
        setData(campaigns as DashboardData);
        setAdData(ads as AdData);
        setProducts(((prods as { products?: Product[] }).products) ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const todayStr = new Date().toISOString().split('T')[0];
  // Multi-campaign-per-day: ALL of today's campaigns (newest first), each shown
  // as its own card so the operator can run unlimited posts.
  const todays = (data?.campaigns ?? [])
    .filter((c) => c.date === todayStr)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

  // Auto-poll while ANY of today's campaigns is in-flight so the operator sees
  // research → generating → creating_video progress without manual refresh.
  const inFlight = todays.some((c) => ['researching', 'generating', 'creating_video'].includes(c.status));
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [inFlight, reload]);

  // Self-heal: drive video finalization from the dashboard so a stuck
  // `creating_video` campaign completes (or times out) even when the */5 cron
  // is misconfigured (e.g. CRON_SECRET unset → the cron 401s and never runs).
  // Session-authed; fires while ANY campaign is creating_video, every 20s.
  const creatingVideo = todays.some((c) => c.status === 'creating_video');
  useEffect(() => {
    if (!creatingVideo) return;
    const finalize = () =>
      fetch('/api/marketing/finalize', { method: 'POST', cache: 'no-store' })
        .then(() => reload())
        .catch(() => {});
    finalize();
    const id = setInterval(finalize, 20000);
    return () => clearInterval(id);
  }, [creatingVideo, reload]);
  const history = data?.campaigns.filter((c) => c.status === 'published').slice(0, 10) ?? [];

  async function approve(campaignId: string, approved: boolean, options: { text_only?: boolean } = {}) {
    if (!campaignId) return;
    setApproving(true);
    setBusyId(campaignId);
    await fetch('/api/marketing/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, campaign_id: campaignId, text_only: options.text_only ?? false }),
    });
    setApproving(false);
    setBusyId(null);
    reload();
  }

  async function deleteCampaign(campaignId: string) {
    if (!campaignId) return;
    if (!confirm('¿Eliminar esta campaña por completo? Si ya está publicada, también se borrará el post en redes. Esta acción no se puede deshacer.')) return;
    setBusyId(campaignId);
    await fetch('/api/marketing/campaign-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId }),
    }).catch(() => {});
    setBusyId(null);
    reload();
  }

  async function editCampaign(campaignId: string, fields: Record<string, string>) {
    if (!campaignId) return;
    setBusyId(campaignId);
    await fetch('/api/marketing/campaign-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId, fields }),
    }).catch(() => {});
    setBusyId(null);
    reload();
  }

  async function deletePublished(campaignId: string) {
    if (!confirm('¿Eliminar este post de Facebook e Instagram? Esta acción no se puede deshacer.')) return;
    await fetch('/api/marketing/delete-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId }),
    });
    reload();
  }

  async function generate(
    options: {
      force?: boolean;
      isNew?: boolean;
      campaignId?: string | null;
      category?: string | null;
      productSku?: string | null;
      guidance?: string | null;
      language?: 'es' | 'en' | 'both';
      media?: 'image' | 'video' | 'both';
    } = {}
  ) {
    const { force = false, isNew = false, campaignId, category, productSku, guidance, language = 'es', media = 'image' } = options;
    if (force && !confirm('¿Regenerar esta campaña? La versión actual se perderá.')) return;
    setGenerating(true);
    if (campaignId) setBusyId(campaignId);
    try {
      // 'both' = generate a Spanish campaign and an English campaign (separate
      // posts). Each is its own campaign row.
      const langs: Array<'es' | 'en'> = language === 'both' ? ['es', 'en'] : [language];
      for (const lang of langs) {
        const qs = new URLSearchParams();
        if (force) qs.set('force', 'true');
        if (isNew) qs.set('new', 'true');               // always insert a fresh campaign
        if (campaignId) qs.set('campaign_id', campaignId); // regenerate a specific one
        if (category) qs.set('category', category);
        if (productSku) qs.set('product_sku', productSku);
        if (guidance && guidance.trim()) qs.set('guidance', guidance.trim());
        qs.set('language', lang);
        qs.set('media', media);
        await fetch(`/api/cron/marketing-daily?${qs.toString()}`, { cache: 'no-store' });
      }
    } finally {
      setGenerating(false);
      setBusyId(null);
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

  const content0 = todays[0]?.marketing_content?.[0];

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-surface-900">
      {/* Minimal header — narrower padding on phone so the stats and refresh
          icon don't push the title off-screen on a 375px-wide iPhone SE. */}
      <div className="px-4 sm:px-6 py-3 border-b border-surface-600 bg-surface-800 flex items-center justify-between shrink-0 gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-100 truncate">Marketing</h2>
          <p className="text-[11px] text-gray-500 truncate">
            {formatDate(new Date().toISOString().split('T')[0])}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {adData?.configured && adData.spend && adData.spend.this_week > 0 && (
            <span className="hidden sm:inline text-[11px] text-gray-500">
              Gasto semana: <span className="text-brand-400 font-semibold">${adData.spend.this_week.toFixed(2)}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => reload()}
            className="text-base text-gray-500 hover:text-gray-300 min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Refrescar"
            aria-label="Refrescar"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-5 max-w-3xl mx-auto w-full">

        {/* ────────  RUN NEW CAMPAIGN (always available) ──────── */}
        <CategoryLauncher
          products={products}
          onPick={(cat, opts) => generate({ isNew: true, category: cat, ...opts })}
          busy={generating}
          heading={todays.length > 0 ? 'Crear otra campaña' : undefined}
        />

        {/* ────────  TODAY'S CAMPAIGNS (one card each) ──────── */}
        {todays.map((c) => (
          <CampaignHero
            key={c.id}
            campaign={c}
            products={products}
            inFlight={['researching', 'generating', 'creating_video'].includes(c.status)}
            approving={approving && busyId === c.id}
            generating={generating && busyId === c.id}
            busy={busyId === c.id}
            onApprove={(approved, opts) => approve(c.id, approved, opts)}
            onRegenerate={(cat, opts) => generate({ force: true, campaignId: c.id, category: cat, ...opts })}
            onDeletePublished={() => deletePublished(c.id)}
            onDelete={() => deleteCampaign(c.id)}
            onEdit={(fields) => editCampaign(c.id, fields)}
          />
        ))}

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

        {/* ───────  SEND OFFER TO LEADS ─────── */}
        <SendOfferPanel />

        {/* ───────  PAYPAL PAY-LINK GENERATOR ─────── */}
        <PayLinkPanel products={products} />

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
  products,
  inFlight,
  approving,
  generating,
  busy,
  onApprove,
  onRegenerate,
  onDeletePublished,
  onDelete,
  onEdit,
}: {
  campaign: Campaign;
  products: Product[];
  inFlight: boolean;
  approving: boolean;
  generating: boolean;
  busy: boolean;
  onApprove: (approved: boolean, options?: { text_only?: boolean }) => void;
  onRegenerate: (cat: string, opts?: { productSku?: string | null; guidance?: string | null; language?: 'es' | 'en' | 'both'; media?: 'image' | 'video' | 'both' }) => void;
  onDeletePublished: () => void;
  onDelete: () => void;
  onEdit: (fields: Record<string, string>) => void;
}) {
  const [productSku, setProductSku] = useState<string>(campaign.product_sku ?? '');
  const [guidance, setGuidance] = useState<string>('');
  const [regenLang, setRegenLang] = useState<'es' | 'en' | 'both'>(
    (campaign.language as 'es' | 'en' | 'both') ?? 'es',
  );
  const [regenMedia, setRegenMedia] = useState<'image' | 'video' | 'both'>('image');
  const [editing, setEditing] = useState(false);
  const content = campaign.marketing_content?.[0];
  const [draftFb, setDraftFb] = useState<string>(content?.facebook_post ?? '');
  const [draftIg, setDraftIg] = useState<string>(content?.instagram_caption ?? '');
  const [draftYt, setDraftYt] = useState<string>(content?.youtube_title ?? '');
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
            <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-300">
              {campaign.language === 'en' ? '🇺🇸 English' : '🇪🇸 Español'}
            </span>
            {categoryLabel && (
              <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-300">{categoryLabel}</span>
            )}
            {campaign.product_sku && (
              <span className="px-2 py-0.5 rounded-full bg-surface-700 text-gray-300">{campaign.product_sku}</span>
            )}
          </div>
        </div>

        {/* Per-card actions: Edit text + Delete. Available on every card. */}
        <div className="flex items-center gap-1.5 shrink-0">
          {content && !inFlight && (
            <button
              type="button"
              onClick={() => {
                setDraftFb(content?.facebook_post ?? '');
                setDraftIg(content?.instagram_caption ?? '');
                setDraftYt(content?.youtube_title ?? '');
                setEditing((v) => !v);
              }}
              disabled={busy}
              className="px-2.5 py-1.5 rounded-lg bg-surface-700 hover:bg-surface-600 text-gray-300 text-xs transition-colors disabled:opacity-50"
              title="Editar el texto del post a mano"
            >
              {editing ? '✕ Cerrar' : '✏️ Editar'}
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800/40 text-red-200 text-xs transition-colors disabled:opacity-50"
            title="Eliminar esta campaña por completo"
          >
            🗑️ Eliminar
          </button>
        </div>
      </div>

      {/* Inline editor — hand-edit the post copy before approving. */}
      {editing && content && (
        <div className="mx-5 mb-3 p-3 rounded-lg bg-surface-800 border border-surface-600 space-y-3">
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Texto Facebook</label>
            <textarea
              value={draftFb}
              onChange={(e) => setDraftFb(e.target.value)}
              rows={6}
              className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Caption Instagram</label>
            <textarea
              value={draftIg}
              onChange={(e) => setDraftIg(e.target.value)}
              rows={4}
              className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Título YouTube</label>
            <input
              value={draftYt}
              onChange={(e) => setDraftYt(e.target.value)}
              className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onEdit({ facebook_post: draftFb, instagram_caption: draftIg, youtube_title: draftYt });
                setEditing(false);
              }}
              disabled={busy}
              className="flex-1 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy ? 'Guardando…' : '💾 Guardar cambios'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-surface-700 hover:bg-surface-600 text-gray-300 text-xs disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

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
      {content && <FacebookPreview content={content} productSku={campaign.product_sku} />}

      {/* Primary CTA — stacks vertically on phones (full-width tap targets,
          ≥48pt high) and inlines back into a row on tablet+. Each button keeps
          a 12px vertical pad so phones always meet Apple HIG's 44pt touch
          target even at the smallest text size. */}
      {readyToApprove && (
        <div className="px-4 sm:px-5 py-4 bg-surface-800/60 border-t border-surface-700 space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={() => onApprove(true)}
              disabled={approving}
              className="flex-1 min-h-[48px] py-3 px-4 rounded-lg bg-green-600 hover:bg-green-500 active:bg-green-700 text-white font-semibold text-sm transition-colors disabled:opacity-50"
            >
              {approving ? 'Publicando...' : '✅ Publicar con video'}
            </button>
            <button
              onClick={() => onApprove(true, { text_only: true })}
              disabled={approving}
              className="min-h-[48px] py-3 px-4 rounded-lg bg-surface-700 hover:bg-surface-600 active:bg-surface-500 text-gray-200 text-sm transition-colors disabled:opacity-50"
              title="Publica solo el texto (FB) y la imagen del producto (IG). Omite YouTube."
            >
              📝 Solo texto
            </button>
            <button
              onClick={() => onApprove(false)}
              disabled={approving}
              className="min-h-[48px] py-3 px-4 rounded-lg bg-surface-700 hover:bg-surface-600 active:bg-surface-500 text-gray-300 text-sm transition-colors disabled:opacity-50"
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

      {/* Already published — allow operator to delete + republish */}
      {campaign.status === 'published' && (
        <div className="px-5 py-4 bg-surface-800/60 border-t border-surface-700 flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500">
            Publicado en Facebook{content?.instagram_post_id ? ' + Instagram' : ''}
            {content?.youtube_video_id ? ' + YouTube' : ''}.
          </p>
          <button
            onClick={onDeletePublished}
            className="px-3 py-2 rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800/40 text-red-200 text-xs transition-colors"
            title="Borra el post en Meta y vuelve a 'pending_approval' para que puedas re-publicar (o regenerar)"
          >
            🗑️ Eliminar de redes
          </button>
        </div>
      )}

      {/* Secondary: regenerate tiles (always visible so you can redirect any time) */}
      <div className="px-5 py-4 border-t border-surface-700 space-y-3">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider">
          {inFlight ? 'Cancelar y regenerar como' : readyToApprove ? 'O regenerar como' : 'Regenerar como'}
        </p>

        <CustomBriefPanel
          products={products}
          productSku={productSku}
          guidance={guidance}
          onProductChange={setProductSku}
          onGuidanceChange={setGuidance}
        />

        {/* Language for the regenerated post (es / en / both). */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Idioma</label>
          <div className="flex gap-1.5">
            {([
              ['es', '🇪🇸 Español'],
              ['en', '🇺🇸 English'],
              ['both', '🌐 Ambos'],
            ] as const).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setRegenLang(val)}
                disabled={generating}
                className={`flex-1 text-[11px] px-2 py-1.5 rounded border transition-colors disabled:opacity-50 ${
                  regenLang === val
                    ? 'bg-brand-500 border-brand-500 text-white'
                    : 'bg-surface-800 border-surface-600 text-gray-300 hover:bg-surface-700'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Format for the regenerated post (image / video / both). */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Formato</label>
          <div className="flex gap-1.5">
            {([
              ['image', '📷 Imagen'],
              ['video', '🎬 Video'],
              ['both', '🎬+📷 Ambos'],
            ] as const).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setRegenMedia(val)}
                disabled={generating}
                className={`flex-1 text-[11px] px-2 py-1.5 rounded border transition-colors disabled:opacity-50 ${
                  regenMedia === val
                    ? 'bg-brand-500 border-brand-500 text-white'
                    : 'bg-surface-800 border-surface-600 text-gray-300 hover:bg-surface-700'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {CATEGORIES.map((c) => {
            const current = campaign.category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() =>
                  onRegenerate(c.value, {
                    productSku: productSku || null,
                    guidance: guidance || null,
                    language: regenLang,
                    media: regenMedia,
                  })
                }
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

function CategoryLauncher({
  products,
  onPick,
  busy,
  heading,
}: {
  products: Product[];
  onPick: (
    cat: string,
    opts: { productSku?: string | null; guidance?: string | null; language?: 'es' | 'en' | 'both'; media?: 'image' | 'video' | 'both' },
  ) => void;
  busy: boolean;
  heading?: string;
}) {
  const [productSku, setProductSku] = useState<string>('');
  const [guidance, setGuidance] = useState<string>('');
  const [language, setLanguage] = useState<'es' | 'en' | 'both'>('es');
  const [media, setMedia] = useState<'image' | 'video' | 'both'>('image');

  // When there are already campaigns today, render as a compact collapsible
  // "create another" panel so it doesn't dominate the list.
  const isExtra = !!heading;

  return (
    <details className="card p-6" open={!isExtra}>
      <summary className={isExtra ? 'cursor-pointer text-sm font-medium text-brand-400 list-none' : 'hidden'}>
        ➕ {heading}
      </summary>
      <div className="text-center mb-5" style={isExtra ? { marginTop: '1rem' } : undefined}>
        <p className="text-3xl mb-2">{isExtra ? '➕' : '📭'}</p>
        <p className="text-sm text-gray-300">{isExtra ? 'Crear otra campaña para hoy' : 'Aún no hay campaña para hoy'}</p>
        <p className="text-[11px] text-gray-500 mt-1">Elige un ángulo para generar el contenido:</p>
      </div>

      <div className="mb-4">
        <CustomBriefPanel
          products={products}
          productSku={productSku}
          guidance={guidance}
          onProductChange={setProductSku}
          onGuidanceChange={setGuidance}
        />
      </div>

      <div className="mb-4">
        <label className="block text-[11px] text-gray-500 mb-1">Idioma</label>
        <div className="flex gap-2">
          {([
            ['es', '🇪🇸 Español'],
            ['en', '🇺🇸 English'],
            ['both', '🌐 Ambos'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setLanguage(val)}
              disabled={busy}
              className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors disabled:opacity-50 ${
                language === val
                  ? 'bg-brand-500 border-brand-500 text-white'
                  : 'bg-surface-800 border-surface-600 text-gray-300 hover:bg-surface-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          &quot;Ambos&quot; genera un post en español y otro en inglés (el video se crea solo para el español).
        </p>
      </div>

      <div className="mb-4">
        <label className="block text-[11px] text-gray-500 mb-1">Formato</label>
        <div className="flex gap-2">
          {([
            ['image', '📷 Imagen'],
            ['video', '🎬 Video'],
            ['both', '🎬+📷 Ambos'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setMedia(val)}
              disabled={busy}
              className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors disabled:opacity-50 ${
                media === val
                  ? 'bg-brand-500 border-brand-500 text-white'
                  : 'bg-surface-800 border-surface-600 text-gray-300 hover:bg-surface-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          Imagen = rápido y económico. Video = clip Higgsfield (más caro, tarda unos minutos).
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onPick(c.value, { productSku: productSku || null, guidance: guidance || null, language, media })}
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
    </details>
  );
}

function CustomBriefPanel({
  products,
  productSku,
  guidance,
  onProductChange,
  onGuidanceChange,
}: {
  products: Product[];
  productSku: string;
  guidance: string;
  onProductChange: (sku: string) => void;
  onGuidanceChange: (text: string) => void;
}) {
  const grouped = products.reduce<Record<string, Product[]>>((acc, p) => {
    const key = p.category ?? 'otros';
    (acc[key] ??= []).push(p);
    return acc;
  }, {});
  const categoryOrder = Object.keys(grouped).sort();

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[11px] text-gray-500 mb-1">
          Producto (opcional)
        </label>
        <select
          value={productSku}
          onChange={(e) => onProductChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-surface-800 border border-surface-600 text-xs text-gray-200 focus:outline-none focus:border-brand-500"
        >
          <option value="">🔄 Rotación automática (por día del año)</option>
          {categoryOrder.map((cat) => (
            <optgroup key={cat} label={cat.toUpperCase()}>
              {grouped[cat].map((p) => {
                const specs: string[] = [];
                if (p.battery_capacity_wh) specs.push(`${p.battery_capacity_wh}Wh`);
                if (p.output_watts) specs.push(`${p.output_watts}W`);
                const price = p.sell_price ? ` · $${Number(p.sell_price).toFixed(0)}` : '';
                const specStr = specs.length ? ` · ${specs.join(' · ')}` : '';
                return (
                  <option key={p.sku} value={p.sku}>
                    {p.sku} — {p.name}{specStr}{price}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[11px] text-gray-500 mb-1">
          Guía para la IA (opcional)
        </label>
        <textarea
          value={guidance}
          onChange={(e) => onGuidanceChange(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Ej: Habla sobre la nueva oferta de envío gratis, enfócate en familias con niños pequeños, menciona que es ideal para apagones nocturnos..."
          className="w-full px-2 py-1.5 rounded bg-surface-800 border border-surface-600 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-brand-500 resize-y"
        />
        <p className="text-[10px] text-gray-600 mt-0.5">
          La IA respetará esta guía siempre que no choque con el código de conducta. Máx 2000 caracteres.
        </p>
      </div>
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

function FacebookPreview({ content, productSku }: { content: ContentRow; productSku?: string | null }) {
  const body = content.facebook_post ?? content.instagram_caption ?? '';
  const lines = body.split('\n');
  const hasVideo = !!content.video_url && content.video_status !== 'failed';

  // Fetch the publish-ready product image so the operator sees the actual
  // visual for an image/text post (no video). Matches what the publisher sends.
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  useEffect(() => {
    if (hasVideo || !productSku) { setImgUrl(null); return; }
    let alive = true;
    fetch(`/api/marketing/product-image?sku=${encodeURIComponent(productSku)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setImgUrl(d?.image_url ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [productSku, hasVideo]);

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
        {hasVideo ? (
          <video controls src={content.video_url!} className="mt-3 w-full rounded" />
        ) : imgUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgUrl} alt="Imagen del producto" className="mt-3 w-full rounded border border-gray-200" />
        ) : null}
      </div>
      <VideoStatusChip content={content} className="mt-3" />

      {/* Per-channel text preview — see exactly what each platform gets. */}
      {(content.instagram_caption || content.youtube_title) && (
        <div className="max-w-xl mx-auto mt-3 space-y-2">
          {content.instagram_caption && (
            <details className="rounded bg-surface-800/70 ring-1 ring-surface-600 p-2.5">
              <summary className="text-[11px] text-gray-400 cursor-pointer">📸 Instagram caption</summary>
              <p className="text-xs text-gray-300 whitespace-pre-wrap mt-1.5">{content.instagram_caption}</p>
            </details>
          )}
          {content.youtube_title && (
            <details className="rounded bg-surface-800/70 ring-1 ring-surface-600 p-2.5">
              <summary className="text-[11px] text-gray-400 cursor-pointer">▶️ YouTube</summary>
              <p className="text-xs text-gray-200 font-medium mt-1.5">{content.youtube_title}</p>
              {content.youtube_description && (
                <p className="text-xs text-gray-400 whitespace-pre-wrap mt-1">{content.youtube_description}</p>
              )}
            </details>
          )}
        </div>
      )}
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

// ─────────────────  SEND OFFER TO LEADS  ─────────────────
// Sends a Meta-approved WhatsApp template offer to leads in customer_profiles.
// Reads coupon from shared Oiikon discount_codes (single source of truth).
// STRICT per-recipient language. See: /api/marketing/send-offer

interface CouponRow {
  code: string;
  description: string | null;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  min_order_total: number | null;
  eligible_brand: string | null;
  valid_until: string | null;
}

interface TemplatePreview {
  language: string;
  header?: { type: string; link?: string | null; text?: string | null };
  body?: { text: string; rendered: string };
  footer?: { text: string };
  buttons?: Array<{ type: string; text: string; url?: string | null }>;
}

interface SendOfferPlan {
  recipientCount: number;
  skippedRecentlyMessaged?: number;
  breakdownByLanguage: { es: number; en: number };
  coupon: {
    code: string;
    discount: number;
    type: string;
    eligible_brand?: string | null;
    min_order_total?: number | null;
  } | null;
  templateName: string;
  sampleRecipients: Array<{ phone: string; language: string; name: string | null }>;
  templatePreviews?: TemplatePreview[];
  previewDebug?: {
    wabaId?: string | null;
    wabaSource?: string;
    templatesOk?: boolean;
    templatesCount?: number;
    matchedCount?: number;
    error?: string;
  } | null;
}

interface SendOfferResult {
  ok: boolean;
  sentCount: number;
  totalCount: number;
  coupon: { code: string; discount: number; type: string } | null;
  results: Array<{ phone: string; language?: string; success: boolean; error?: unknown; wa_message_id?: string }>;
}

function WhatsAppMessagePreview({ preview }: { preview: TemplatePreview }) {
  const flag = preview.language.startsWith('en') ? '🇺🇸' : '🇪🇸';
  const langLabel = preview.language.startsWith('en') ? 'English' : 'Español';
  const isImageHeader = preview.header?.type?.toUpperCase() === 'IMAGE';
  const isTextHeader = preview.header?.type?.toUpperCase() === 'TEXT';
  const bodyLines = (preview.body?.rendered ?? '').split('\n');

  return (
    <div className="rounded-lg overflow-hidden border border-surface-600 bg-[#0b141a]">
      <div className="px-3 py-1.5 bg-surface-800 border-b border-surface-600 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">
          {flag} {langLabel} ({preview.language})
        </span>
        <span className="text-[10px] text-gray-600 font-mono">WhatsApp</span>
      </div>
      <div className="p-3" style={{ background: '#0b141a', backgroundImage: 'radial-gradient(ellipse at top, #0e1b22, #0b141a)' }}>
        <div className="bg-[#005c4b] rounded-lg max-w-[280px] shadow-md overflow-hidden">
          {isImageHeader && preview.header?.link && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview.header.link}
              alt="header"
              className="w-full max-h-48 object-cover"
            />
          )}
          {isTextHeader && preview.header?.text && (
            <div className="px-3 pt-2 text-sm font-semibold text-white">
              {preview.header.text}
            </div>
          )}
          <div className="px-3 pt-2 pb-1 text-[13px] leading-snug text-white whitespace-pre-wrap">
            {bodyLines.map((l, i) => (
              <p key={i} className="min-h-[1em]">{l}</p>
            ))}
          </div>
          {preview.footer?.text && (
            <div className="px-3 pb-1 text-[11px] text-white/60 italic">
              {preview.footer.text}
            </div>
          )}
          <div className="px-3 pb-2 text-[10px] text-white/50 text-right">
            {new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} ✓✓
          </div>
          {preview.buttons && preview.buttons.length > 0 && (
            <div className="border-t border-white/10 divide-y divide-white/10">
              {preview.buttons.map((b, i) => (
                <div
                  key={i}
                  className="px-3 py-2 text-center text-[13px] text-[#53bdeb] font-medium"
                  title={b.url || undefined}
                >
                  {b.type === 'URL' ? '🔗 ' : ''}
                  {b.text}
                </div>
              ))}
            </div>
          )}
        </div>
        {preview.buttons?.some((b) => b.url) && (
          <p className="mt-2 text-[10px] text-gray-600 break-all">
            URL: {preview.buttons.find((b) => b.url)?.url}
          </p>
        )}
      </div>
    </div>
  );
}

// Local approximation of the offer message, used when Meta's live template
// components can't be fetched (WABA unresolved, template not yet approved, or
// a fetch error). Mirrors the oiikon_offer body shape so the operator always
// sees roughly what each lead receives instead of a blank panel.
function buildFallbackPreviews(plan: SendOfferPlan): TemplatePreview[] {
  const code = plan.coupon?.code ?? 'CODIGO';
  const disc = plan.coupon
    ? plan.coupon.type === 'percentage'
      ? `${plan.coupon.discount}%`
      : `$${plan.coupon.discount}`
    : '';
  const nameEs = plan.sampleRecipients.find((r) => r.language === 'es')?.name || 'amigo/a';
  const nameEn = plan.sampleRecipients.find((r) => r.language === 'en')?.name || 'friend';
  const out: TemplatePreview[] = [];
  if (plan.breakdownByLanguage.es > 0 || plan.breakdownByLanguage.en === 0) {
    out.push({
      language: 'es',
      body: {
        text: '',
        rendered: `Hola ${nameEs}, código ${code} te da ${disc} OFF en oiikon.com. Responde STOP para cancelar.`,
      },
    });
  }
  if (plan.breakdownByLanguage.en > 0) {
    out.push({
      language: 'en_US',
      body: {
        text: '',
        rendered: `Hi ${nameEn}, code ${code} gets you ${disc} OFF at oiikon.com. Reply STOP to opt out.`,
      },
    });
  }
  return out;
}

// ─────────────────  PAYPAL PAY-LINK GENERATOR  ─────────────────
// Creates a Facebook-style tap-to-pay link for an EXACT total (qty × price +
// shipping), guest checkout. For customers who "only know how to pay by link."
function PayLinkPanel({ products }: { products: Product[] }) {
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [shipping, setShipping] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; total?: number; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (!sku) return;
    setBusy(true);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch('/api/marketing/pay-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ sku, qty }], shipping, note: note || undefined }),
      });
      const d = await res.json();
      setResult(res.ok ? { url: d.url, total: d.total } : { error: d.error || `Error ${res.status}` });
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card">
      <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-gray-200 flex items-center gap-2">
        💳 Crear link de pago (PayPal · checkout como invitado)
      </summary>
      <div className="px-4 pb-4 space-y-3 border-t border-surface-700 pt-3">
        <p className="text-[11px] text-gray-500">
          Genera un link de pago con el total exacto (cantidad × precio + envío). El cliente lo toca y paga como invitado con tarjeta, PayPal o Apple Pay — sin crear cuenta. Ideal para «mi tío solo sabe pagar por link».
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Producto</label>
            <select
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
            >
              <option value="">— elige —</option>
              {products.map((p) => (
                <option key={p.sku} value={p.sku}>
                  {p.sku} — {p.name?.slice(0, 40)}{p.sell_price ? ` · $${p.sell_price}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Cantidad</label>
              <input
                type="number" min={1} max={99} value={qty}
                onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Envío $ (0 = gratis)</label>
              <input
                type="number" min={0} value={shipping}
                onChange={(e) => setShipping(Math.max(0, Number(e.target.value) || 0))}
                className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
              />
            </div>
          </div>
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nota interna (opcional) — ej. envío a Houston, cliente Carlos"
          className="w-full text-xs bg-surface-900 border border-surface-600 rounded p-2 text-gray-200"
        />
        <button
          type="button"
          onClick={generate}
          disabled={busy || !sku}
          className="w-full py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Generando…' : '💳 Generar link de pago'}
        </button>

        {result?.error && (
          <p className="text-xs text-red-300 bg-red-950/40 rounded p-2">⚠️ {result.error}</p>
        )}
        {result?.url && (
          <div className="rounded-lg bg-surface-800 border border-surface-600 p-3 space-y-2">
            <p className="text-xs text-gray-300">
              Total: <span className="font-semibold text-green-400">${result.total?.toFixed(2)}</span> · listo para enviar
            </p>
            <div className="flex gap-2">
              <input readOnly value={result.url} className="flex-1 text-[11px] bg-surface-900 border border-surface-600 rounded p-2 text-gray-300" />
              <button
                type="button"
                onClick={() => { navigator.clipboard?.writeText(result.url!); setCopied(true); }}
                className="px-3 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs whitespace-nowrap"
              >
                {copied ? '✓ Copiado' : 'Copiar'}
              </button>
            </div>
            <p className="text-[10px] text-gray-500">Pega este link en WhatsApp. El cliente paga como invitado — sin cuenta.</p>
          </div>
        )}
      </div>
    </details>
  );
}

function SendOfferPanel() {
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [templateName, setTemplateName] = useState('oiikon_offer_v1');
  const [couponCode, setCouponCode] = useState('');
  const [audience, setAudience] = useState<'all' | 'es' | 'en'>('all');
  const [plan, setPlan] = useState<SendOfferPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendOfferResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/marketing/coupons', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setCoupons(d.coupons ?? []))
      .catch(() => setCoupons([]));
  }, []);

  async function runDryRun() {
    setPlanError(null);
    setSendResult(null);
    setSendError(null);
    setPlan(null);
    if (!templateName.trim()) {
      setPlanError('templateName requerido (debe ser una plantilla Meta aprobada)');
      return;
    }
    const res = await fetch('/api/marketing/send-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateName: templateName.trim(),
        couponCode: couponCode || undefined,
        audience,
        dryRun: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setPlanError(data?.error ? String(data.error) : `HTTP ${res.status}`);
      return;
    }
    setPlan(data as SendOfferPlan);
  }

  async function runSend() {
    if (!plan) return;
    if (!confirm(`¿Enviar oferta WhatsApp a ${plan.recipientCount} leads? No se puede deshacer.`)) return;
    setSending(true);
    setSendResult(null);
    setSendError(null);
    const res = await fetch('/api/marketing/send-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateName: templateName.trim(),
        couponCode: couponCode || undefined,
        audience,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (!res.ok || data?.error) {
      setSendError(data?.error ? String(data.error) : `HTTP ${res.status}`);
      return;
    }
    setSendResult(data as SendOfferResult);
    setPlan(null);
  }

  return (
    <details className="card" open>
      <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium text-gray-200 hover:bg-surface-800/50 flex items-center justify-between">
        <span>💬 Enviar oferta a leads de WhatsApp</span>
        <span className="text-xs text-gray-500">{coupons.length} cupones activos</span>
      </summary>
      <div className="px-4 py-3 space-y-3 border-t border-surface-700">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
              Plantilla Meta (aprobada)
            </label>
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              className="w-full text-sm bg-surface-800 border border-surface-600 rounded px-2 py-1.5 text-gray-200 font-mono"
              placeholder="oiikon_offer_v1"
            />
            <p className="text-[10px] text-gray-600 mt-1">Debe existir en Meta Business Manager con status APPROVED.</p>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
              Cupón (desde discount_codes)
            </label>
            <select
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
              className="w-full text-sm bg-surface-800 border border-surface-600 rounded px-2 py-1.5 text-gray-200"
            >
              <option value="">Sin cupón</option>
              {coupons.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.discount_type === 'percentage' ? `${c.discount_value}%` : `$${c.discount_value}`}
                  {c.eligible_brand ? ` · ${c.eligible_brand}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Audiencia</label>
          <div className="flex flex-wrap gap-2">
            {(['all', 'es', 'en'] as const).map((a) => (
              <label key={a} className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  name="audience"
                  value={a}
                  checked={audience === a}
                  onChange={() => setAudience(a)}
                />
                {a === 'all' ? 'Todos' : a === 'es' ? '🇪🇸 Solo español' : '🇺🇸 Solo English'}
              </label>
            ))}
          </div>
        </div>

        {plan && (
          <div className="space-y-3">
            <div className="bg-surface-800 border border-surface-600 rounded p-3 text-xs space-y-1">
              <p className="text-gray-300">
                <strong>Plan:</strong> {plan.recipientCount} destinatarios · ES: {plan.breakdownByLanguage.es}, EN:{' '}
                {plan.breakdownByLanguage.en}
              </p>
              {!!plan.skippedRecentlyMessaged && plan.skippedRecentlyMessaged > 0 && (
                <p className="text-gray-500">
                  Se omitieron {plan.skippedRecentlyMessaged} leads que ya recibieron una oferta en las últimas 24h.
                </p>
              )}
              {plan.coupon && (
                <p className="text-gray-400">
                  <strong>Cupón:</strong> {plan.coupon.code} ·{' '}
                  {plan.coupon.type === 'percentage' ? `${plan.coupon.discount}%` : `$${plan.coupon.discount}`}
                  {plan.coupon.eligible_brand && ` · solo ${plan.coupon.eligible_brand}`}
                  {plan.coupon.min_order_total ? ` · pedido mín. $${plan.coupon.min_order_total}` : ''}
                </p>
              )}
              <p className="text-gray-500 font-mono text-[10px]">Plantilla: {plan.templateName}</p>
            </div>

            {plan.coupon && (plan.coupon.eligible_brand || plan.coupon.min_order_total) && (
              <div className="text-[11px] text-amber-300 bg-amber-900/20 border border-amber-800/50 rounded px-3 py-2 leading-relaxed">
                ⚠ Este cupón es condicional
                {plan.coupon.eligible_brand ? `: solo aplica a productos ${plan.coupon.eligible_brand}` : ''}
                {plan.coupon.min_order_total ? ` con pedido mínimo de $${plan.coupon.min_order_total}` : ''}.
                Se enviará a los {plan.recipientCount} leads, pero solo podrán canjearlo quienes compren un
                producto que califique (el checkout de oiikon.com valida marca, mínimo y margen).
              </div>
            )}

            {(() => {
              const hasReal = !!(plan.templatePreviews && plan.templatePreviews.length > 0);
              const previews = hasReal ? plan.templatePreviews! : buildFallbackPreviews(plan);
              return (
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wider text-gray-500">
                    Vista previa del mensaje (lo que recibe cada lead)
                  </p>
                  {!hasReal && (
                    <p className="text-[11px] text-amber-300 bg-amber-900/20 border border-amber-800/50 rounded px-3 py-2 leading-relaxed">
                      ⚠ Vista previa aproximada — no se pudo cargar la plantilla real de Meta
                      {plan.previewDebug?.error
                        ? ` (${plan.previewDebug.error})`
                        : plan.previewDebug?.matchedCount === 0
                          ? ` (la plantilla "${plan.templateName}" no se encontró aprobada en Meta)`
                          : plan.previewDebug?.wabaSource === 'unset'
                            ? ' (WABA no resuelto: revisa META_WHATSAPP_BUSINESS_ACCOUNT_ID)'
                            : ''}
                      . El texto real depende de la plantilla aprobada; verifícala en Meta antes de enviar.
                    </p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {previews.map((tp) => (
                      <WhatsAppMessagePreview key={tp.language} preview={tp} />
                    ))}
                  </div>
                </div>
              );
            })()}

            {plan.sampleRecipients && plan.sampleRecipients.length > 0 && (
              <details className="bg-surface-800/50 border border-surface-600 rounded">
                <summary className="px-3 py-2 cursor-pointer text-[11px] text-gray-400 hover:bg-surface-800/80">
                  Muestra de {plan.sampleRecipients.length} (se enviará a los {plan.recipientCount})
                </summary>
                <div className="border-t border-surface-700 divide-y divide-surface-700 max-h-40 overflow-y-auto">
                  {plan.sampleRecipients.map((r) => (
                    <div key={r.phone} className="flex items-center justify-between px-3 py-1.5 text-[11px]">
                      <span className="text-gray-300 font-mono">+{r.phone}</span>
                      <span className="text-gray-500">
                        {r.name || '—'} · {r.language === 'es' ? '🇪🇸' : '🇺🇸'}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {planError && (
          <div className="text-xs text-red-400 bg-red-900/30 border border-red-800/50 rounded px-2 py-1.5">
            ⚠ {planError}
          </div>
        )}

        {sendError && (
          <div className="text-xs text-red-400 bg-red-900/30 border border-red-800/50 rounded px-2 py-1.5">
            ⚠ {sendError}
          </div>
        )}

        {sendResult && (
          <div className="text-xs text-green-300 bg-green-900/20 border border-green-800/50 rounded px-2 py-1.5">
            ✓ Enviados: {sendResult.sentCount}/{sendResult.totalCount}
            {sendResult.coupon && ` · cupón ${sendResult.coupon.code}`}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={runDryRun}
            className="text-xs px-3 py-1.5 bg-surface-700 hover:bg-surface-600 text-gray-200 rounded"
          >
            Vista previa
          </button>
          <button
            type="button"
            onClick={runSend}
            disabled={!plan || sending}
            className="text-xs px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded"
          >
            {sending ? 'Enviando...' : 'Enviar oferta'}
          </button>
        </div>

        <p className="text-[10px] text-gray-600 leading-relaxed">
          Lee desde <code>customer_profiles</code> (este agente) + <code>discount_codes</code> (Oiikon, fuente única).
          Idioma estricto: nunca envía contenido en idioma no preferido. Cada envío queda registrado en{' '}
          <code>messages</code> con role=system.
        </p>
      </div>
    </details>
  );
}
