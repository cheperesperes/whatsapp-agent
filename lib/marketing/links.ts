/**
 * Post links — make every oiikon.com link in a post (1) point to a page that exists
 * and (2) carry campaign tags so visits, carts and orders can be traced to the post.
 *
 * Why (1): posts were written with https://oiikon.com/product/<sku>, but product pages
 * live at /product/<slug> (0 of 44 slugs equal the SKU), so every link hit the 404 page.
 * Why (2): the storefront keeps utm_* through checkout and create_web_order stores them
 * on the order; Google Analytics groups sessions by them.
 */
import { createServiceClient } from '@/lib/supabase';

const SITE = 'https://www.oiikon.com';

/** SKU (upper-case) → product page slug, for every active storefront product. */
export async function loadProductSlugs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { data } = await createServiceClient()
      .from('products')
      .select('sku, slug, url_slug')
      .eq('is_active', true);
    for (const p of data ?? []) {
      const slug = (p.url_slug as string | null)?.trim() || (p.slug as string | null)?.trim();
      if (p.sku && slug) out[String(p.sku).toUpperCase()] = slug;
    }
  } catch (e) {
    console.warn('[marketing/links] loadProductSlugs failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

export function productPageUrl(slug: string | null | undefined, language: 'es' | 'en' = 'es'): string {
  if (!slug) return language === 'en' ? `${SITE}/catalog` : `${SITE}/catalogo`;
  return `${SITE}${language === 'en' ? '/en' : ''}/product/${slug}`;
}

export interface LinkTags {
  source: 'facebook' | 'instagram' | 'youtube' | 'whatsapp';
  /** e.g. sol-2026-11-23-es */
  campaign: string;
  /** e.g. the product SKU */
  content?: string | null;
}

export function campaignTag(date: string, language: string): string {
  return `sol-${date}-${language === 'en' ? 'en' : 'es'}`;
}

/**
 * Rewrites every oiikon.com URL in `text`: fixes /product/<sku> to the real slug page
 * (in the post's language) and adds utm_source/medium/campaign/content when absent.
 * Anything that is not an oiikon.com URL is left untouched.
 */
export function prepareLinks(
  text: string | null | undefined,
  slugs: Record<string, string>,
  language: 'es' | 'en',
  tags: LinkTags,
): string {
  if (!text) return text ?? '';
  return text.replace(/https?:\/\/(?:www\.)?oiikon\.com[^\s<>"')\]]*/gi, (raw) => {
    // Sentence punctuation right after a link is not part of it.
    const trail = raw.match(/[.,;:!?]+$/)?.[0] ?? '';
    const core = trail ? raw.slice(0, -trail.length) : raw;
    let u: URL;
    try { u = new URL(core); } catch { return raw; }
    u.protocol = 'https:';
    u.host = 'www.oiikon.com';
    const m = u.pathname.match(/^\/(?:en\/)?product\/([^/]+)\/?$/i);
    if (m) {
      const seg = decodeURIComponent(m[1]);
      const slug = slugs[seg.toUpperCase()] ?? seg; // a SKU → its slug; an existing slug stays
      u.pathname = `${language === 'en' ? '/en' : ''}/product/${slug}`;
    }
    const q = u.searchParams;
    if (!q.has('utm_source')) q.set('utm_source', tags.source);
    if (!q.has('utm_medium')) q.set('utm_medium', 'social');
    if (!q.has('utm_campaign')) q.set('utm_campaign', tags.campaign);
    if (tags.content && !q.has('utm_content')) q.set('utm_content', tags.content);
    return u.toString() + trail;
  });
}
