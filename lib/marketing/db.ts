import { createServiceClient } from '@/lib/supabase';

export interface MarketingCampaign {
  id: string;
  date: string;
  status: string;
  research_brief: string | null;
  daily_theme: string | null;
  product_sku: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketingContent {
  id: string;
  campaign_id: string;
  facebook_post: string | null;
  instagram_caption: string | null;
  google_ad_headlines: string[] | null;
  google_ad_descriptions: string[] | null;
  youtube_script: string | null;
  youtube_title: string | null;
  youtube_description: string | null;
  youtube_tags: string[] | null;
  heygen_video_id: string | null;
  video_url: string | null;
  video_status: string;
  facebook_post_id: string | null;
  instagram_post_id: string | null;
  youtube_video_id: string | null;
  published_at: string | null;
  created_at: string;
}

export interface FacebookGroup {
  id: string;
  name: string;
  url: string;
  description: string | null;
  member_count: number | null;
  last_posted_at: string | null;
  active: boolean;
  discovered_at: string;
}

export interface CampaignPerformance {
  campaign_id: string;
  facebook_likes: number;
  facebook_comments: number;
  facebook_shares: number;
  facebook_reach: number;
  instagram_likes: number;
  instagram_comments: number;
  youtube_views: number;
  youtube_likes: number;
  fetched_at: string;
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export async function createCampaign(date: string): Promise<MarketingCampaign> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from('marketing_campaigns')
    .insert({ date, status: 'researching' })
    .select()
    .single();
  if (error) throw new Error(`createCampaign: ${error.message}`);
  return data as MarketingCampaign;
}

export async function updateCampaign(
  id: string,
  patch: Partial<Pick<MarketingCampaign, 'status' | 'research_brief' | 'daily_theme' | 'product_sku' | 'error_message'>>
) {
  const sb = createServiceClient();
  const { error } = await sb.from('marketing_campaigns').update(patch).eq('id', id);
  if (error) throw new Error(`updateCampaign: ${error.message}`);
}

export async function getCampaignByDate(date: string): Promise<MarketingCampaign | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_campaigns')
    .select('*')
    .eq('date', date)
    .maybeSingle();
  return data as MarketingCampaign | null;
}

export async function getPendingApprovalCampaign(): Promise<MarketingCampaign | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_campaigns')
    .select('*')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as MarketingCampaign | null;
}

export async function listCampaigns(limit = 30): Promise<MarketingCampaign[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_campaigns')
    .select('*')
    .order('date', { ascending: false })
    .limit(limit);
  return (data ?? []) as MarketingCampaign[];
}

// ── Content ───────────────────────────────────────────────────────────────────

export async function createContent(
  campaignId: string,
  data: Partial<Omit<MarketingContent, 'id' | 'campaign_id' | 'created_at'>>
): Promise<MarketingContent> {
  const sb = createServiceClient();
  const { data: row, error } = await sb
    .from('marketing_content')
    .insert({ campaign_id: campaignId, ...data })
    .select()
    .single();
  if (error) throw new Error(`createContent: ${error.message}`);
  return row as MarketingContent;
}

export async function updateContent(
  campaignId: string,
  patch: Partial<Omit<MarketingContent, 'id' | 'campaign_id' | 'created_at'>>
) {
  const sb = createServiceClient();
  const { error } = await sb
    .from('marketing_content')
    .update(patch)
    .eq('campaign_id', campaignId);
  if (error) throw new Error(`updateContent: ${error.message}`);
}

export async function getContent(campaignId: string): Promise<MarketingContent | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_content')
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle();
  return data as MarketingContent | null;
}

// ── Facebook Groups ────────────────────────────────────────────────────────────

export async function upsertFacebookGroups(
  groups: Array<{ name: string; url: string; description: string }>
) {
  if (groups.length === 0) return;
  const sb = createServiceClient();
  // Upsert by URL — preserve existing member_count and last_posted_at
  const rows = groups.map((g) => ({
    name: g.name,
    url: g.url,
    description: g.description,
    active: true,
    discovered_at: new Date().toISOString(),
  }));
  await sb.from('marketing_facebook_groups').upsert(rows, { onConflict: 'url', ignoreDuplicates: false });
}

export async function getActiveGroups(): Promise<FacebookGroup[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_facebook_groups')
    .select('*')
    .eq('active', true)
    .order('last_posted_at', { ascending: true, nullsFirst: true })
    .limit(50);
  return (data ?? []) as FacebookGroup[];
}

export async function markGroupPosted(id: string) {
  const sb = createServiceClient();
  await sb
    .from('marketing_facebook_groups')
    .update({ last_posted_at: new Date().toISOString() })
    .eq('id', id);
}

// ── Performance ────────────────────────────────────────────────────────────────

export async function upsertPerformance(
  campaignId: string,
  metrics: Partial<Omit<CampaignPerformance, 'campaign_id' | 'fetched_at'>>
) {
  const sb = createServiceClient();
  await sb.from('marketing_performance').upsert(
    { campaign_id: campaignId, ...metrics, fetched_at: new Date().toISOString() },
    { onConflict: 'campaign_id' }
  );
}

export async function getRecentPerformance(limit = 7): Promise<CampaignPerformance[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_performance')
    .select('*')
    .order('fetched_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as CampaignPerformance[];
}
