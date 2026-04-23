import { NextRequest, NextResponse } from 'next/server';
import { conductDailyResearch } from '@/lib/marketing/research';
import { generateMarketingContent } from '@/lib/marketing/content';
import { createProductReviewVideo } from '@/lib/marketing/heygen';
import {
  createCampaign,
  updateCampaign,
  createContent,
  getCampaignByDate,
  upsertFacebookGroups,
} from '@/lib/marketing/db';
import { loadMemory, consolidateMemory, formatMemoryForPrompt } from '@/lib/marketing/memory';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled = (process.env.MARKETING_CRON_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json({ ok: false, reason: 'MARKETING_CRON_ENABLED=false' }, { status: 503 });
  }

  const today = new Date().toISOString().split('T')[0];
  const runId = `marketing-${today}`;
  const startedAt = Date.now();

  // Skip if already ran today
  const existing = await getCampaignByDate(today);
  if (existing && !['failed'].includes(existing.status)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: `Campaign for ${today} already exists (status: ${existing.status})`,
      campaign_id: existing.id,
    });
  }

  let campaignId = existing?.id ?? '';

  try {
    // ── Step 1: Create campaign record ─────────────────────────────────────
    if (!existing) {
      const campaign = await createCampaign(today);
      campaignId = campaign.id;
    } else {
      // Retry failed campaign
      campaignId = existing.id;
      await updateCampaign(campaignId, { status: 'researching', error_message: null });
    }

    // ── Step 2: Consolidate memory from previous campaigns ─────────────────
    await consolidateMemory();
    const memory = await loadMemory();
    const memoryPrompt = formatMemoryForPrompt(memory);

    // ── Step 3: Research ───────────────────────────────────────────────────
    console.log(`[marketing-daily] ${runId} — conducting research`);
    await updateCampaign(campaignId, { status: 'researching' });

    const { brief, facebookGroups } = await conductDailyResearch();

    // Persist newly discovered groups
    await upsertFacebookGroups(facebookGroups);

    // Augment brief with memory
    const fullBrief = memoryPrompt ? `${brief}\n\n${memoryPrompt}` : brief;

    await updateCampaign(campaignId, {
      status: 'generating',
      research_brief: brief,
    });

    // ── Step 4: Load products ──────────────────────────────────────────────
    const sb = createServiceClient();
    const { data: products } = await sb
      .from('products')
      .select('sku, name, category, capacity_wh, output_watts, price_usd')
      .eq('in_stock', true)
      .order('sku');

    if (!products || products.length === 0) {
      throw new Error('No in-stock products found in catalog');
    }

    // ── Step 5: Generate content ───────────────────────────────────────────
    console.log(`[marketing-daily] ${runId} — generating content`);
    const content = await generateMarketingContent(fullBrief, products);

    await updateCampaign(campaignId, {
      status: 'creating_video',
      daily_theme: content.daily_theme,
      product_sku: content.product_sku,
    });

    // ── Step 6: Save content to DB ─────────────────────────────────────────
    await createContent(campaignId, {
      facebook_post: content.facebook_post,
      instagram_caption: content.instagram_caption,
      google_ad_headlines: content.google_ad_headlines,
      google_ad_descriptions: content.google_ad_descriptions,
      youtube_script: content.youtube_script,
      youtube_title: content.youtube_title,
      youtube_description: content.youtube_description,
      youtube_tags: content.youtube_tags,
      video_status: 'pending',
    });

    // ── Step 7: Submit HeyGen video job ────────────────────────────────────
    console.log(`[marketing-daily] ${runId} — submitting HeyGen video job`);
    try {
      const videoJob = await createProductReviewVideo(content.youtube_script, campaignId);
      const { updateContent } = await import('@/lib/marketing/db');
      await updateContent(campaignId, {
        heygen_video_id: videoJob.video_id,
        video_status: 'processing',
      });
      console.log(`[marketing-daily] ${runId} — HeyGen video_id: ${videoJob.video_id}`);
    } catch (heygenErr) {
      // HeyGen failure is non-fatal — we can still approve and post text content
      console.warn(`[marketing-daily] ${runId} — HeyGen failed: ${heygenErr}`);
      await updateCampaign(campaignId, { status: 'pending_approval' });

      // Notify Eduardo even without video
      const { sendMarketingPreview } = await import('@/lib/marketing/notify');
      await sendMarketingPreview(campaignId, null);

      return NextResponse.json({
        ok: true,
        run_id: runId,
        campaign_id: campaignId,
        status: 'pending_approval_no_video',
        duration_ms: Date.now() - startedAt,
      });
    }

    // Campaign stays in 'creating_video' — HeyGen webhook will flip to 'pending_approval'
    console.log(`[marketing-daily] ${runId} — video submitted, waiting for HeyGen webhook`);

    return NextResponse.json({
      ok: true,
      run_id: runId,
      campaign_id: campaignId,
      status: 'creating_video',
      theme: content.daily_theme,
      product: content.product_sku,
      groups_discovered: facebookGroups.length,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[marketing-daily] ${runId} FAILED:`, message);
    if (campaignId) await updateCampaign(campaignId, { status: 'failed', error_message: message });
    return NextResponse.json({ ok: false, error: message, run_id: runId }, { status: 500 });
  }
}
