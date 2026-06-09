import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceClient } from '@/lib/supabase';
import { updateCampaign, updateContent } from '@/lib/marketing/db';
import { sendMarketingPreview } from '@/lib/marketing/notify';
import { resolvePendingImages } from '@/lib/marketing/image-finalize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Operator-driven video finalizer. Mirrors the finalize-videos CRON, but is
// gated on the dashboard Supabase SESSION instead of CRON_SECRET — so videos
// still complete even when the cron is misconfigured (e.g. CRON_SECRET unset →
// the cron 401s forever and campaigns hang in `creating_video`). The dashboard
// calls this on load / while polling whenever today's campaign is stuck.

const PROVIDER = (process.env.VIDEO_PROVIDER ?? 'heygen').toLowerCase();
const TIMEOUT_MIN = Number(process.env.VIDEO_FINALIZE_TIMEOUT_MIN ?? 15);

async function getStatus(jobId: string) {
  if (PROVIDER === 'higgsfield') {
    const { getVideoStatus } = await import('@/lib/marketing/higgsfield');
    return getVideoStatus(jobId);
  }
  const { getVideoStatus } = await import('@/lib/marketing/heygen');
  return getVideoStatus(jobId);
}

async function isAuthenticated(): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  }
  const sb = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: { getAll: () => cookies().getAll(), setAll: () => {} },
  });
  const { data: { user } } = await sb.auth.getUser();
  return !!user;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const { data: rows, error } = await sb
    .from('marketing_campaigns')
    .select('id, updated_at, product_sku, marketing_content(heygen_video_id, video_status)')
    .eq('status', 'creating_video');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const c of rows ?? []) {
    const content = Array.isArray((c as any).marketing_content)
      ? (c as any).marketing_content[0]
      : (c as any).marketing_content;
    const jobId: string | null = content?.heygen_video_id ?? null;
    const ageMin = (Date.now() - new Date((c as any).updated_at).getTime()) / 60000;

    const timeOut = async (reason: string) => {
      await Promise.all([
        updateContent((c as any).id, { video_status: 'failed' }),
        updateCampaign((c as any).id, { status: 'pending_approval', error_message: reason }),
      ]);
      await sendMarketingPreview((c as any).id, null);
    };

    if (!jobId) {
      if (ageMin > TIMEOUT_MIN) {
        await timeOut('No video job id — finalized as text-only.');
        results.push({ id: (c as any).id, action: 'failed_no_job' });
      } else {
        results.push({ id: (c as any).id, action: 'no_job_waiting' });
      }
      continue;
    }

    let st;
    try {
      st = await getStatus(jobId);
    } catch (e: any) {
      if (ageMin > TIMEOUT_MIN) {
        await timeOut(`Video status check failing (${e?.message ?? e}) — finalized text-only.`);
        results.push({ id: (c as any).id, action: 'failed_status_error' });
      } else {
        results.push({ id: (c as any).id, action: 'status_error_retry', err: String(e?.message ?? e) });
      }
      continue;
    }

    if (st.status === 'completed') {
      await Promise.all([
        updateContent((c as any).id, { video_status: 'ready', video_url: st.video_url ?? undefined }),
        updateCampaign((c as any).id, { status: 'pending_approval', error_message: null }),
      ]);
      await sendMarketingPreview((c as any).id, st.video_url ?? null);
      results.push({ id: (c as any).id, action: 'finalized_ready', has_url: !!st.video_url });
    } else if (st.status === 'failed') {
      await timeOut(st.error ?? 'Video generation failed.');
      results.push({ id: (c as any).id, action: 'finalized_failed' });
    } else if (ageMin > TIMEOUT_MIN) {
      await timeOut(`Video timed out after ~${Math.round(ageMin)} min — finalized text-only.`);
      results.push({ id: (c as any).id, action: 'timed_out' });
    } else {
      results.push({ id: (c as any).id, action: 'still_processing', age_min: Math.round(ageMin) });
    }
  }

  // Resolve any pending AI scene images (orthogonal to video / campaign status).
  const imageResults = await resolvePendingImages(sb);

  return NextResponse.json({
    ok: true,
    provider: PROVIDER,
    checked: rows?.length ?? 0,
    results,
    images: imageResults,
  });
}
