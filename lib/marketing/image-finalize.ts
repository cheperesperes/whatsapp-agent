import type { SupabaseClient } from '@supabase/supabase-js';
import { updateContent } from '@/lib/marketing/db';

/**
 * Self-healing AI-image finalizer. The marketing-daily cron submits a Higgsfield
 * Soul image job and leaves the content row at image_status='processing',
 * relying on the provider webhook to flip it to 'ready'. That webhook is
 * unreliable (same as video), so both the dashboard finalizer and the cron poll
 * the status API directly and finalize every pending image — or time it out to
 * 'failed' so the preview cleanly falls back to the stock product photo.
 *
 * Orthogonal to campaign status (image is non-blocking) — never touches the
 * campaign row, so it composes with the video lifecycle for media='both'.
 */
const IMAGE_TIMEOUT_MIN = Number(process.env.IMAGE_FINALIZE_TIMEOUT_MIN ?? 10);

export async function resolvePendingImages(
  sb: SupabaseClient,
): Promise<Array<Record<string, unknown>>> {
  const { data: rows, error } = await sb
    .from('marketing_content')
    .select('campaign_id, image_request_id, image_status, created_at')
    .eq('image_status', 'processing');
  if (error || !rows?.length) return [];

  const { getImageStatus } = await import('@/lib/marketing/higgsfield');
  const results: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const campaignId = (r as any).campaign_id as string;
    const jobId = (r as any).image_request_id as string | null;
    const ageMin = (Date.now() - new Date((r as any).created_at).getTime()) / 60000;

    if (!jobId) {
      if (ageMin > IMAGE_TIMEOUT_MIN) {
        await updateContent(campaignId, { image_status: 'failed' });
        results.push({ campaign_id: campaignId, action: 'image_failed_no_job' });
      } else {
        results.push({ campaign_id: campaignId, action: 'image_no_job_waiting' });
      }
      continue;
    }

    let st;
    try {
      st = await getImageStatus(jobId);
    } catch (e: any) {
      if (ageMin > IMAGE_TIMEOUT_MIN) {
        await updateContent(campaignId, { image_status: 'failed' });
        results.push({ campaign_id: campaignId, action: 'image_failed_status_error' });
      } else {
        results.push({ campaign_id: campaignId, action: 'image_status_error_retry', err: String(e?.message ?? e) });
      }
      continue;
    }

    if (st.status === 'completed' && st.image_url) {
      await updateContent(campaignId, { image_url: st.image_url, image_status: 'ready' });
      results.push({ campaign_id: campaignId, action: 'image_ready' });
    } else if (st.status === 'failed') {
      await updateContent(campaignId, { image_status: 'failed' });
      results.push({ campaign_id: campaignId, action: 'image_failed' });
    } else if (ageMin > IMAGE_TIMEOUT_MIN) {
      await updateContent(campaignId, { image_status: 'failed' });
      results.push({ campaign_id: campaignId, action: 'image_timed_out' });
    } else {
      results.push({ campaign_id: campaignId, action: 'image_still_processing', age_min: Math.round(ageMin) });
    }
  }

  return results;
}
