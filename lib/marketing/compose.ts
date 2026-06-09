import sharp from 'sharp';

/**
 * Composite real-product marketing images. The PRODUCT is always the real
 * catalog photo (never AI-drawn), so it's pixel-perfect; AI/scene only ever
 * appears in the BACKGROUND. This is the rulebook's #1 accuracy fix
 * (render the scene, composite the real product on top).
 */

/**
 * Remove the white studio background from a catalog product photo via a border
 * flood-fill: only clears white pixels CONNECTED to the image edge, so interior
 * white (logo text, LCD highlights) is never punched out. Returns a trimmed
 * RGBA PNG cutout. Throws if the result is implausibly small (bad key).
 */
export async function cutoutWhiteBg(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .resize({ width: 1400, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const isWhite = (i: number): boolean => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn >= 226 && mx - mn <= 24;
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
  // Sanity: a real product shot on white clears a big chunk of border. If almost
  // nothing cleared, the photo wasn't white-bg → bail so we fall back to stock.
  if (cleared < width * height * 0.05) throw new Error('cutout: background not white enough');
  return sharp(data, { raw: { width, height, channels: 4 } }).png().trim().toBuffer();
}

/** Deterministic studio-gradient background (fallback when no scene asset). */
export async function makeGradientScene(w = 1080, h = 1350): Promise<Buffer> {
  const svg = `<svg width="${w}" height="${h}"><defs><radialGradient id="g" cx="50%" cy="38%" r="80%"><stop offset="0%" stop-color="#3a4452"/><stop offset="100%" stop-color="#11151b"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface ComposeOpts {
  scale?: number;      // product width ÷ scene width (default 0.56)
  baseline?: number;   // floor line as fraction of height where the base sits (default 0.9)
  brightness?: number; // dim the product to match scene light (default 0.9)
}

/**
 * Composite a product cutout onto a scene background with a soft contact shadow
 * and a subtle grade so it sits naturally. Returns a JPEG buffer.
 */
export async function composeProductOnScene(
  sceneBuf: Buffer,
  productCutout: Buffer,
  opts: ComposeOpts = {},
): Promise<Buffer> {
  const { scale = 0.56, baseline = 0.9, brightness = 0.9 } = opts;
  const sm = await sharp(sceneBuf).metadata();
  const W = sm.width ?? 1080, H = sm.height ?? 1350;
  const pw = Math.round(W * scale);
  const prod = await sharp(productCutout)
    .resize({ width: pw })
    .modulate({ brightness, saturation: 0.96 })
    .png()
    .toBuffer();
  const ph = (await sharp(prod).metadata()).height ?? Math.round(pw * 0.66);
  const left = Math.round((W - pw) / 2);
  const bottomY = Math.round(H * baseline);
  const top = bottomY - ph;
  const shW = Math.round(pw * 0.96), shH = Math.round(ph * 0.2);
  const shadow = await sharp(
    Buffer.from(
      `<svg width="${shW}" height="${shH}"><ellipse cx="${shW / 2}" cy="${shH / 2}" rx="${shW * 0.46}" ry="${shH * 0.46}" fill="black" opacity="0.6"/></svg>`,
    ),
  ).blur(18).png().toBuffer();
  return sharp(sceneBuf)
    .composite([
      { input: shadow, top: bottomY - Math.round(shH * 0.45), left: Math.round((W - shW) / 2) },
      { input: prod, top, left },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}
