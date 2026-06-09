import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { conductDailyResearch } from '@/lib/marketing/research';
import { generateMarketingContent, validateContent } from '@/lib/marketing/content';
import { createProductReviewVideo } from '@/lib/marketing/heygen';
import { createProductVideo as createHiggsfieldVideo } from '@/lib/marketing/higgsfield';

// Video provider switch. 'heygen' (default) = talking-avatar video reading the
// script. 'higgsfield' = cinematic product-motion clip from the product image
// (needs HIGGSFIELD_API_KEY). Reversible — flip back by unsetting the env.
const VIDEO_PROVIDER = (process.env.VIDEO_PROVIDER ?? 'heygen').toLowerCase();
import {
  createCampaign,
  updateCampaign,
  createContent,
  updateContent,
  getCampaignByDate,
  getCampaignById,
  upsertFacebookGroups,
  getContentLearningSignals,
} from '@/lib/marketing/db';
import { buildSceneImagePrompt } from '@/lib/marketing/scene';
import { createProductImage } from '@/lib/marketing/higgsfield';
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

  // Language of THIS campaign. Default 'es' so the scheduled cron and any
  // legacy callers behave exactly as before. The dashboard sends 'en' for the
  // English variant. Video (HeyGen, the costly step) is only produced for the
  // primary language to keep cost at one video/day.
  const langParam = req.nextUrl.searchParams.get('language');
  const language: 'es' | 'en' = langParam === 'en' ? 'en' : 'es';
  const PRIMARY_LANGUAGE: 'es' | 'en' = 'es';

  // Media format selector: 'image' (text + product photo, fast/cheap), 'video'
  // (Higgsfield/HeyGen clip), or 'both'. Default 'video' when no param so the
  // SCHEDULED cron behaves exactly as before; the dashboard sends an explicit
  // choice (defaults to 'image' there). Video still only renders for the
  // primary language to cap cost at one video/day.
  const mediaParam = req.nextUrl.searchParams.get('media');
  const media: 'image' | 'video' | 'both' =
    mediaParam === 'image' || mediaParam === 'both' ? mediaParam : 'video';
  const makeVideo = (media === 'video' || media === 'both') && language === PRIMARY_LANGUAGE;
  // AI scene image (Higgsfield Soul) for image/both campaigns. Language-agnostic
  // (a visual), generated for ES + EN. Non-blocking: it never gates the campaign.
  const makeImage = media === 'image' || media === 'both';

  // Multi-campaign-per-day: the dashboard can launch unlimited posts.
  //  • new=true        → ALWAYS create a fresh campaign (operator "Run new campaign")
  //  • force=true       → regenerate a SPECIFIC existing campaign in place
  //  • neither          → scheduled-cron behavior: one idempotent post per (date,language)
  const wantNew = req.nextUrl.searchParams.get('new') === 'true';

  // When regenerating a specific campaign, the dashboard passes its id so we
  // target exactly that row (instead of "today's" first match).
  const targetId = req.nextUrl.searchParams.get('campaign_id')?.trim() || null;

  // The cron (and legacy callers) still de-dupe per (date,language). A manual
  // "Run new campaign" (new=true) bypasses that and always inserts a new row.
  let existing = targetId
    ? await getCampaignById(targetId)
    : wantNew
      ? null
      : await getCampaignByDate(today, language);

  if (existing && !force && !wantNew && !['failed'].includes(existing.status)) {
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
      const campaign = await createCampaign(today, category, language);
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
    const { data: catalogProducts } = await sb
      .from('agent_product_catalog')
      .select('sku, name, category, battery_capacity_wh, battery_capacity_ah, output_watts, sell_price, original_price, discount_percentage, cuba_total_price, ideal_for')
      .eq('in_stock', true)
      .order('sku');

    if (!catalogProducts || catalogProducts.length === 0) {
      throw new Error('No in-stock products found in catalog');
    }

    // Offer LIVE prices. The catalog is the agent's product list (specs,
    // selection) but its price can lag; the real selling price lives on the
    // storefront `products` table. Read it READ-ONLY (never write price columns
    // — the two tables differ on purpose) and quote the live net price:
    //   net = products.sell_price (anchor) × (1 − discount%)
    // keeping the anchor as the strike-through "antes". Also drop anything the
    // storefront currently marks out of stock. Falls back to the catalog price
    // for any SKU with no live row.
    const skus = catalogProducts.map((p) => (p as { sku: string }).sku);
    const { data: liveRows } = await sb
      .from('products')
      .select('sku, sell_price, discount_percentage, in_stock')
      .in('sku', skus);
    const liveBySku = new Map<string, { sell_price: number | null; discount_percentage: number | null; in_stock: boolean | null }>();
    for (const r of liveRows ?? []) {
      liveBySku.set(String((r as { sku: string }).sku).toUpperCase(), r as { sell_price: number | null; discount_percentage: number | null; in_stock: boolean | null });
    }
    const products = catalogProducts
      .filter((p) => liveBySku.get(String((p as { sku: string }).sku).toUpperCase())?.in_stock !== false)
      .map((p) => {
        const live = liveBySku.get(String((p as { sku: string }).sku).toUpperCase());
        const anchor = live ? Number(live.sell_price ?? 0) : 0;
        if (live && anchor > 0) {
          const disc = Number(live.discount_percentage ?? 0);
          const net = Math.round(anchor * (1 - disc / 100) * 100) / 100;
          return { ...p, sell_price: net, original_price: anchor, discount_percentage: disc };
        }
        return p; // no live row → keep catalog price as fallback
      });

    if (products.length === 0) {
      throw new Error('No live in-stock products found');
    }

    // ── Step 5: Generate content + compliance check ────────────────────────
    // Learn before generating: feed recent posts (avoid repeats) + our best
    // performers (emulate what engaged). Degrades to empty on no history.
    console.log(`[marketing-daily] ${runId} — generating content`);
    const learning = await getContentLearningSignals().catch(() => ({ recent: [], top: [] }));
    const content = await generateMarketingContent(fullBrief, products, category, {
      productSku,
      guidance,
      language,
      recent: learning.recent,
      top: learning.top,
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

    // ── Step 6a: AI scene image (Higgsfield Soul) — non-blocking ───────────
    // Reference-condition on the REAL product photo so the product stays
    // accurate (rulebook §Product integrity: scene/lighting only, never the
    // product). A finalizer poll resolves the job; degrades to the stock photo
    // if anything fails, so it can NEVER regress the existing image preview.
    if (makeImage && content.product_sku) {
      try {
        const refImgs = await getProductImages(content.product_sku, 1);
        if (refImgs.length > 0) {
          const chosen = products.find(
            (p) => String((p as { sku: string }).sku).toUpperCase() === content.product_sku!.toUpperCase(),
          );
          const prompt = buildSceneImagePrompt({
            category,
            productName: (chosen as { name?: string } | undefined)?.name ?? null,
            sku: content.product_sku,
            themeHint: content.daily_theme,
          });
          const job = await createProductImage(prompt, campaignId, refImgs, { aspectRatio: '3:4' });
          await updateContent(campaignId, { image_request_id: job.image_id, image_status: 'processing' });
          console.log(`[marketing-daily] ${runId} — Soul image job ${job.image_id}`);
        } else {
          await updateContent(campaignId, { image_status: 'skipped' });
        }
      } catch (imgErr) {
        // Non-fatal: preview falls back to the stock photo. PERSIST the error to
        // the campaign so a failed image is self-diagnosing from the dashboard/DB
        // (Vercel logs aren't always reachable) — tells us the exact model/param
        // to fix without guessing. Preserve any compliance warnings already set.
        const imgMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
        console.warn(`[marketing-daily] ${runId} — image gen failed (falls back to stock photo): ${imgMsg}`);
        await updateContent(campaignId, { image_status: 'failed' });
        await updateCampaign(campaignId, {
          error_message: [
            warnings.length ? `⚠️ ${warnings.join(' · ')}` : null,
            `🖼️ Imagen IA falló: ${imgMsg}`,
          ].filter(Boolean).join(' | ').slice(0, 2000),
        });
      }
    } else {
      await updateContent(campaignId, { image_status: 'skipped' });
    }

    // ── Step 6b: Non-primary language → skip video (one video/day) ─────────
    // The English variant ships as text-only so we don't pay for a second
    // HeyGen render. It goes straight to approval; the operator can attach a
    // video manually if a topic warrants it.
    if (!makeVideo) {
      await updateContent(campaignId, { video_status: 'skipped' });
      await updateCampaign(campaignId, { status: 'pending_approval' });
      const { sendMarketingPreview } = await import('@/lib/marketing/notify');
      await sendMarketingPreview(campaignId, null);
      return NextResponse.json({
        ok: true,
        run_id: runId,
        campaign_id: campaignId,
        language,
        status: 'pending_approval_no_video',
        theme: content.daily_theme,
        product: content.product_sku,
        duration_ms: Date.now() - startedAt,
      });
    }

    // ── Step 7: Submit HeyGen video job ────────────────────────────────────
    // Pull up to 3 product images so HeyGen can build a multi-scene Reel with
    // the product as the background, instead of the corporate avatar against
    // a flat blue wall (which looks like an obvious AI ad).
    const productImages = content.product_sku
      ? await getProductImages(content.product_sku, 3)
      : [];
    const useHiggsfield = VIDEO_PROVIDER === 'higgsfield' && !!process.env.HIGGSFIELD_API_KEY;
    console.log(`[marketing-daily] ${runId} — submitting ${useHiggsfield ? 'Higgsfield' : 'HeyGen'} video job (${productImages.length} bg images)`);
    try {
      let videoJob: { video_id: string };
      if (useHiggsfield) {
        // Image-to-video: animate the product still with a short, bright motion
        // prompt (Seedance over-flags dark scenes as NSFW — keep it clean).
        // Accuracy tactics (skill playbook): SLOW camera so labels stay legible,
        // concrete nouns, and a strong NEGATIVE baseline forbidding the exact
        // morphs the post-render verification gate catches (warped labels,
        // distorted geometry, duplicated/fabricated parts, morphed logo).
        const motionPrompt =
          `Subtle premium product commercial motion: a very slow, gentle dolly-in and a soft light sweep across the ` +
          `${content.product_sku ?? 'PECRON'} power station. The product stays perfectly sharp, accurate, undistorted and centered; ` +
          `its real labels, text, color, ports and logo remain identical to the input image and fully legible. ` +
          `Bright, clean, photorealistic studio look. ` +
          `Negative: no label warping, no changing or fabricated text, no distorted or melting geometry, ` +
          `no duplicated or extra parts, no morphing logo, no people, no overlay text, no fast moves, no camera shake.`;
        videoJob = await createHiggsfieldVideo(motionPrompt, campaignId, productImages);
      } else {
        videoJob = await createProductReviewVideo(content.youtube_script, campaignId, productImages);
      }
      await updateContent(campaignId, {
        heygen_video_id: videoJob.video_id, // column reused as the video job id regardless of provider
        video_status: 'processing',
      });
      console.log(`[marketing-daily] ${runId} — ${useHiggsfield ? 'Higgsfield' : 'HeyGen'} video_id: ${videoJob.video_id}`);
    } catch (videoErr) {
      // Video failure is non-fatal — we can still approve and post text content
      console.warn(`[marketing-daily] ${runId} — video provider failed: ${videoErr}`);
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
