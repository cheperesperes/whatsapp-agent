-- Marketing Agent Tables
-- Tracks daily AI-generated campaigns: research → content → HeyGen video → publish

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'researching' CHECK (status IN (
    'researching', 'generating', 'creating_video',
    'pending_approval', 'approved', 'publishing', 'published',
    'rejected', 'failed'
  )),
  research_brief TEXT,
  daily_theme TEXT,
  product_sku TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_content (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  facebook_post TEXT,
  instagram_caption TEXT,
  google_ad_headlines TEXT[],
  google_ad_descriptions TEXT[],
  youtube_script TEXT,
  youtube_title TEXT,
  youtube_description TEXT,
  youtube_tags TEXT[],
  heygen_video_id TEXT,
  video_url TEXT,
  video_status TEXT DEFAULT 'pending' CHECK (video_status IN ('pending', 'processing', 'ready', 'failed')),
  facebook_post_id TEXT,
  instagram_post_id TEXT,
  youtube_video_id TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_campaigns_date_idx ON marketing_campaigns (date);
CREATE INDEX IF NOT EXISTS marketing_campaigns_status_idx ON marketing_campaigns (status);
CREATE INDEX IF NOT EXISTS marketing_content_campaign_idx ON marketing_content (campaign_id);

CREATE OR REPLACE FUNCTION update_marketing_campaigns_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketing_campaigns_updated_at ON marketing_campaigns;
CREATE TRIGGER trg_marketing_campaigns_updated_at
  BEFORE UPDATE ON marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_marketing_campaigns_updated_at();

-- Facebook groups discovered by the research agent
CREATE TABLE IF NOT EXISTS marketing_facebook_groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  member_count INTEGER,
  last_posted_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT TRUE,
  discovered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_groups_active_idx ON marketing_facebook_groups (active, last_posted_at);

-- Performance metrics fetched 24h after publishing
CREATE TABLE IF NOT EXISTS marketing_performance (
  campaign_id UUID PRIMARY KEY REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  facebook_likes INTEGER DEFAULT 0,
  facebook_comments INTEGER DEFAULT 0,
  facebook_shares INTEGER DEFAULT 0,
  facebook_reach INTEGER DEFAULT 0,
  instagram_likes INTEGER DEFAULT 0,
  instagram_comments INTEGER DEFAULT 0,
  youtube_views INTEGER DEFAULT 0,
  youtube_likes INTEGER DEFAULT 0,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent's own learning memory (single row, id=1)
CREATE TABLE IF NOT EXISTS marketing_agent_memory (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  top_themes TEXT[] DEFAULT '{}',
  weak_themes TEXT[] DEFAULT '{}',
  best_days TEXT[] DEFAULT '{}',
  style_notes TEXT DEFAULT '',
  group_insights TEXT DEFAULT '',
  product_rotation TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
