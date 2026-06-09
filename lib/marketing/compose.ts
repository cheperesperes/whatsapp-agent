import sharp from 'sharp';

/**
 * Composite real-product marketing images. The PRODUCT is always the real
 * catalog photo (never AI-drawn), so it's pixel-perfect; AI/scene only ever
 * appears in the BACKGROUND. Rulebook's #1 accuracy fix.
 */

/**
 * Cut the product out of its white catalog background:
 *  1) border flood-fill clears white CONNECTED to the edge (never interior
 *     logos/labels), catching light-gray anti-aliased fringe too;
 *  2) a morphological alpha erode (min filter) shaves the residual ~2px white
 *     halo so the cutout reads crisp on light AND dark backgrounds.
 * Returns a trimmed RGBA PNG. Throws if almost nothing cleared (not white-bg).
 */
export async function cutoutWhiteBg(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .resize({ width: 1100, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const isWhite = (i: number): boolean => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn >= 204 && mx - mn <= 34;
  };
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  let cleared = 0;
  while (stack.length) {
    const p = stack.pop() as number;
    const i = p * 4;
    if (!isWhite(i)) continue;
    data[i + 3] = 0; cleared++;
    const x = p % width, y = (p / width) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  if (cleared < width * height * 0.05) throw new Error('cutout: background not white enough');
  // Erode alpha (min filter, R=2) to shave the anti-aliased white halo.
  const a = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) a[i] = data[i * 4 + 3];
  const R = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let mn = 255;
      for (let dy = -R; dy <= R && mn; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx, ny = y + dy;
          const av = nx < 0 || ny < 0 || nx >= width || ny >= height ? 0 : a[ny * width + nx];
          if (av < mn) mn = av;
        }
      }
      data[(y * width + x) * 4 + 3] = mn;
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().trim().toBuffer();
}

/** Premium clean studio-gradient background (no visible rig). */
export async function makeGradientScene(w = 1080, h = 1350): Promise<Buffer> {
  const svg = `<svg width="${w}" height="${h}"><defs><radialGradient id="g" cx="50%" cy="34%" r="85%"><stop offset="0%" stop-color="#46505e"/><stop offset="62%" stop-color="#222831"/><stop offset="100%" stop-color="#0d1014"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface ComposeOpts {
  scale?: number;      // product width ÷ scene width (default 0.72 — hero)
  baseline?: number;   // floor line as fraction of height where the base sits (default 0.8)
  brightness?: number; // dim the product to match scene light (default 0.92)
  reflect?: boolean;   // add a faded floor reflection (good on clean gradients)
}

/**
 * Composite a product cutout onto a scene with a contact shadow (+ optional
 * floor reflection) and a subtle grade so it sits naturally. Returns a JPEG.
 */
export async function composeProductOnScene(
  sceneBuf: Buffer,
  productCutout: Buffer,
  opts: ComposeOpts = {},
): Promise<Buffer> {
  const { scale = 0.72, baseline = 0.8, brightness = 0.92, reflect = false } = opts;
  const sm = await sharp(sceneBuf).metadata();
  const W = sm.width ?? 1080, H = sm.height ?? 1350;
  const pw = Math.round(W * scale);
  const prod = await sharp(productCutout)
    .resize({ width: pw })
    .modulate({ brightness, saturation: 0.97 })
    .png()
    .toBuffer();
  const ph = (await sharp(prod).metadata()).height ?? Math.round(pw * 0.66);
  const left = Math.round((W - pw) / 2);
  const bottomY = Math.round(H * baseline);
  const top = bottomY - ph;

  const layers: sharp.OverlayOptions[] = [];
  if (reflect) {
    const refl = await sharp(prod)
      .flip()
      .composite([{
        input: Buffer.from(
          `<svg width="${pw}" height="${ph}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="white" stop-opacity="0.26"/><stop offset="55%" stop-color="white" stop-opacity="0"/></linearGradient></defs><rect width="${pw}" height="${ph}" fill="url(#f)"/></svg>`,
        ),
        blend: 'dest-in',
      }])
      .png()
      .toBuffer();
    layers.push({ input: refl, top: bottomY + 2, left });
  }
  const shW = Math.round(pw * 0.92), shH = Math.round(ph * 0.16);
  const shadow = await sharp(
    Buffer.from(
      `<svg width="${shW}" height="${shH}"><ellipse cx="${shW / 2}" cy="${shH / 2}" rx="${shW * 0.47}" ry="${shH * 0.47}" fill="black" opacity="0.78"/></svg>`,
    ),
  ).blur(16).png().toBuffer();
  layers.push({ input: shadow, top: bottomY - Math.round(shH * 0.5), left: Math.round((W - shW) / 2) });
  layers.push({ input: prod, top, left });

  return sharp(sceneBuf).composite(layers).jpeg({ quality: 90 }).toBuffer();
}
