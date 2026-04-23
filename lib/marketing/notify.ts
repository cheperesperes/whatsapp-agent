import { sendWhatsAppMessage } from '@/lib/whatsapp';
import { getContent, getActiveGroups } from '@/lib/marketing/db';
import { createServiceClient } from '@/lib/supabase';
import { buildGroupsWhatsAppMessage } from '@/lib/marketing/publisher';

const OPERATOR_PHONE = process.env.OPERATOR_PHONE ?? '+15617024893';

export async function sendMarketingPreview(
  campaignId: string,
  videoUrl: string | null
): Promise<void> {
  const sb = createServiceClient();
  const { data: campaign } = await sb
    .from('marketing_campaigns')
    .select('date, daily_theme, product_sku')
    .eq('id', campaignId)
    .single();

  const content = await getContent(campaignId);
  const groups = await getActiveGroups();

  if (!campaign || !content) return;

  const dateLabel = new Date(campaign.date + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const videoLine = videoUrl
    ? `🎬 *Video listo:* ${videoUrl.slice(0, 80)}...`
    : '🎬 *Video:* En proceso (recibirás confirmación cuando esté listo)';

  const headlinePreview = content.google_ad_headlines?.join(' | ') ?? '—';
  const fbPreview = (content.facebook_post ?? '').slice(0, 250);

  const msg =
    `🎯 *Campaña del ${dateLabel}*\n` +
    `📦 Producto: ${campaign.product_sku ?? '—'}\n` +
    `💡 Tema: _${campaign.daily_theme ?? '—'}_\n\n` +
    `📘 *Facebook (preview):*\n${fbPreview}...\n\n` +
    `${videoLine}\n\n` +
    `📊 *Google Ads:*\n${headlinePreview}\n\n` +
    `👥 *Grupos encontrados:* ${groups.length}\n\n` +
    `Responde *SI* para publicar en todos los canales\n` +
    `Responde *NO* para cancelar esta campaña`;

  try {
    await sendWhatsAppMessage(OPERATOR_PHONE, msg);

    if (groups.length > 0 && content.facebook_post) {
      const groupsMsg = buildGroupsWhatsAppMessage(
        content.facebook_post,
        groups,
        campaign.daily_theme ?? 'Campaña Oiikon'
      );
      await sendWhatsAppMessage(OPERATOR_PHONE, groupsMsg);
    }
  } catch (err) {
    console.warn('[marketing] WhatsApp preview skipped:', err instanceof Error ? err.message : err);
  }
}
