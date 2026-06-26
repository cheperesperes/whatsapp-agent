import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// Admin utility: email a lead a branded product email (real product images +
// a custom message) via Resend. Built for web-widget leads who have no phone —
// email is the only channel to reach them.
//
// Auth: shared-secret token (same pattern as the send-wa-test edge fn). The repo
// is private; this gates the endpoint so it can't be hit anonymously.
// Sends only REAL product images pulled from the products table — never staged
// or fabricated photos.
//
// POST body: { to, sku, message, subject?, lang? }
//   to      – recipient email
//   sku     – product SKU (loads name + real images + price + page URL)
//   message – plain-text body (newlines become <br>); the honest copy
//   subject – optional; defaults from the product name
//   lang    – 'en' | 'es' (CTA + footer language; default 'es')
// ─────────────────────────────────────────────────────────────────────────────

const SEND_TOKEN = 'oiikon-email-2026-06-26-ed-K9m4vR7xN2qLpZ';
const FROM = 'Oiikon <info@oiikon.com>';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? req.headers.get('x-send-token') ?? '';
  if (token !== SEND_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY not set' }, { status: 500 });
  }

  type Body = { to?: string; sku?: string; message?: string; subject?: string; lang?: string };
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const { to, sku, message, subject } = body;
  const lang = body.lang === 'en' ? 'en' : 'es';
  if (!to || !sku || !message) {
    return NextResponse.json({ error: 'to, sku, message required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: product, error } = await supabase
    .from('products')
    .select('name, name_en, primary_image_url, image_url, gallery_images, price, url_slug, slug')
    .ilike('sku', sku)
    .maybeSingle();

  if (error || !product) {
    return NextResponse.json({ error: `product not found: ${sku}`, detail: error?.message }, { status: 404 });
  }

  const imgs: string[] = [];
  const primary = (product.primary_image_url as string | null) ?? (product.image_url as string | null);
  if (primary) imgs.push(primary);
  if (Array.isArray(product.gallery_images)) imgs.push(...(product.gallery_images as string[]));
  const images = [...new Set(imgs.filter(Boolean))].slice(0, 6);

  const slug = (product.url_slug as string | null) ?? (product.slug as string | null) ?? '';
  const productUrl = slug ? `https://oiikon.com/product/${slug}` : 'https://oiikon.com';
  const name = (product.name_en as string | null) ?? (product.name as string | null) ?? sku;
  const price = product.price as string | number | null;

  const messageHtml = esc(String(message)).replace(/\n/g, '<br>');
  const imgHtml = images
    .map((u) => `<img src="${u}" alt="${esc(name)}" style="width:100%;max-width:520px;border-radius:10px;margin:8px 0;display:block;" />`)
    .join('');

  const cta = lang === 'en' ? 'View product →' : 'Ver el producto →';
  const footer =
    lang === 'en'
      ? 'Oiikon · oiikon.com · info@oiikon.com<br/>Authorized U.S. distributor of PECRON · Free shipping to the 48 contiguous states.'
      : 'Oiikon · oiikon.com · info@oiikon.com<br/>Distribuidor autorizado de PECRON en EE.UU. · Envío gratis a los 48 estados continentales.';

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.55;">
    <div style="font-size:22px;font-weight:700;color:#F97316;padding:8px 0 4px;">Oiikon</div>
    <div style="height:3px;background:#F97316;border-radius:2px;margin-bottom:16px;"></div>
    <p style="font-size:15px;">${messageHtml}</p>
    ${imgHtml}
    <p style="font-size:15px;font-weight:600;margin-top:14px;">${esc(name)}${price ? ` — $${price}` : ''}</p>
    <a href="${productUrl}" style="display:inline-block;background:#F97316;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;margin:10px 0;">${cta}</a>
    <p style="font-size:12px;color:#888;margin-top:20px;border-top:1px solid #eee;padding-top:12px;">${footer}</p>
  </div>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: subject ?? (lang === 'en' ? `About your ${name} — Oiikon` : `Sobre tu ${name} — Oiikon`),
      html,
    }),
  });

  const result = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!resp.ok) {
    return NextResponse.json({ error: 'resend failed', status: resp.status, detail: result }, { status: 502 });
  }
  return NextResponse.json({ ok: true, id: result.id, to, sku, images: images.length });
}
