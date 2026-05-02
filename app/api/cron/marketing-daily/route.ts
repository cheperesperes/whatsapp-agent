import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { conductDailyResearch } from '@/lib/marketing/research';
import { generateMarketingContent, validateContent } from '@/lib/marketing/content';
import { createProductReviewVideo } from '@/lib/marketing/heygen';
import {
  createCampaign,
  updateCampaign,
  createContent,
  getCampaignByDate,
  upsertFacebookGroups,
} from '@/lib/marketing/db';
import { loadMemory, consolidateMemory, formatMemoryForPrompt } from '@/lib/marketing/memory';
import { createServiceClient, getProductImages } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // Path 1: Vercel cron — Bearer CRON_SECRET
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) {
    return true;
  }

  // Path 2: dashboard button — authenticated Supabase user via session cookie
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseAnonKey) {
    const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (user) return true;
  }

  // Local dev without CRON_SECRET — allow
  if (!secret && process.env.VERCEL_ENV !== 'production') return true;

  return false;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const enabled = (process.env.MARKETING_CRON_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return NextResponse.json({ ok: false, reason: 'MARKETING_CRON_ENABLED=false' }, { status: 503 });
  }

  const today = new Date().toISOString().split('T')[0];
  const runId = `marketing-${today}`;
  const startedAt = Date.now();
  const force = req.nextUrl.searchParams.get('force') === 'true';
  const categoryParam = req.nextUrl.searchParams.get('category');
  const validCategories = ['educacion', 'tips', 'instalacion', 'baterias', 'apagones', 'familia', 'producto'] as const;
  const category = validCategories.find((v) => v === categoryParam) ?? null;
  const productSkuParam = req.nextUrl.searchParams.get('product_sku')?.trim() ?? '';
  const productSku = productSkuParam ? productSkuParam.toUpperCase() : null;
  const guidanceParam = req.nextUrl.searchParams.get('guidance')?.trim() ?? '';
  const guidance = guidanceParam ? guidanceParam.slice(0, 2000) : null;
  // Language for the generated content. Defaults to 'es' so the existing
  // cron schedule keeps producing Spanish content without code changes.
  // 'en' = English-only US framing; 'bilingual' = ES paragraph + EN paragraph.
  const langParam = req.nextUrl.searchParams.get('lang');
  const language: 'es' | 'en' | 'bilingual' =
    langParam === 'en' || langParam === 'bilingual' ? langParam : 'es';

  // Skip if already ran today (unless force=true)
  let existing = await getCampaignByDate(today);
  if (existing && !force && !['failed'].includes(existing.status)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: `Campaign for ${today} already exists (status: ${existing.status})`,
      campaign_id: existing.id,
    });
  }

  // force=true → reset existing campaign in place (drop content, reset status)
  if (existing && force) {
    const sb = createServiceClient();
    await sb.from('marketing_content').delete().eq('campaign_id', existing.id);
    await sb.from('marketing_performance').delete().eq('campaign_id', existing.id);
  }

  let campaignId = existing?.id ?? '';

  try {
    // ── Step 1: Create or reset campaign record ────────────────────────────
    if (!existing) {
      const campaign = await createCampaign(today, category);
      campaignId = campaign.id;
    } else {
      // Retry failed / force-regenerate
      campaignId = existing.id;
      await updateCampaign(campaignId, {
        status: 'researching',
        error_message: null,
        daily_theme: null,
        product_sku: null,
        research_brief: null,
        category,
      });
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
      .from('agent_product_catalog')
      .select('sku, name, category, battery_capacity_wh, battery_capacity_ah, output_watts, sell_price, original_price, discount_percentage, cuba_total_price, ideal_for')
      .eq('in_stock', true)
      .order('sku');

    if (!products || products.length === 0) {
      throw new Error('No in-stock products found in catalog');
    }

    // ── Step 5: Generate content + compliance check ────────────────────────
    console.log(`[marketing-daily] ${runId} — generating content (lang=${language})`);
    const content = await generateMarketingContent(fullBrief, products, category, {
      productSku,
      guidance,
      language,
    });

    const warnings = validateContent(content);
    if (warnings.length > 0) {
      console.warn(`[marketing-daily] ${runId} — compliance warnings:`, warnings);
    }

    await updateCampaign(campaignId, {
      status: 'creating_video',
      daily_theme: content.daily_theme,
      product_sku: content.product_sku,
      error_message: warnings.length > 0 ? `⚠️ Revisión recomendada: ${warnings.join(' · ')}` : null,
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
    // Pull up to 3 product images so HeyGen can build a multi-scene Reel with
    // the product as the background, instead of the corporate avatar against
    // a flat blue wall (which looks like an obvious AI ad).
    const productImages = content.product_sku
      ? await getProductImages(content.product_sku, 3)
      : [];
    console.log(`[marketing-daily] ${runId} — submitting HeyGen video job (${productImages.length} bg images)`);
    try {
      const videoJob = await createProductReviewVideo(content.youtube_script, campaignId, productImages);
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
