/**
 * House-style scene-image prompt builder for Higgsfield Soul (image-to-image).
 *
 * Mirrors the locked recipe in the `oiikon-marketing-studio` skill: the REAL
 * product photo is passed as the reference (so Soul restyles the SCENE, never
 * invents the product), with strict realism rules (no cords, heavy units kept
 * grounded, ONE product, no AI-rendered text). Specs/offer overlays are added
 * later as deterministic layers — we NEVER let the image model render text.
 *
 * Rulebook §Product integrity: Higgsfield changes scene/lighting/background
 * ONLY — never product geometry, labels, color, or logo.
 */

export type SceneCategory =
  | 'producto'
  | 'educacion'
  | 'tips'
  | 'instalacion'
  | 'baterias'
  | 'apagones'
  | 'familia'
  | null;

// One concrete scene per content angle. Concrete nouns beat abstract
// ("elegant lifestyle") — specificity is what reduces hallucination.
const SCENE_BY_CATEGORY: Record<string, string> = {
  apagones:
    'a warm living room at dusk during a power outage — a lamp and the fridge glowing softly, calm and safe, a storm visible through the window',
  familia:
    'a cozy family living room in the evening, warm lamplight, the home staying powered and comfortable',
  baterias:
    'a clean studio hero shot on seamless light-gray backdrop with premium soft lighting',
  producto:
    'a clean studio hero shot on seamless light-gray backdrop with premium soft lighting',
  instalacion:
    'an off-grid cabin interior by day, wood counter, a solar panel visible through the window',
  tips:
    'a tidy home backup setup in a bright living room, everyday and approachable',
  educacion:
    'a clean, bright explanatory setting — neutral home interior with soft natural light',
};

// Hurricane season (Jun–Nov) → survival/outage default; otherwise a neutral
// studio hero. Camping/RV is summer-secondary; we keep the safe default to
// avoid scene drift on no-category posts.
function seasonalDefaultScene(month: number): string {
  const isHurricaneSeason = month >= 5 && month <= 10; // Jun(5)–Nov(10), 0-indexed
  return isHurricaneSeason
    ? 'a warm living room at dusk during a power outage — a lamp and the fridge glowing softly, calm and safe'
    : 'a clean studio hero shot on seamless light-gray backdrop with premium soft lighting';
}

/**
 * Build the full Soul prompt. `productName`/`sku` anchor the model to the
 * reference; `{SCENE}` is filled from the content angle (seasonal fallback).
 */
export function buildSceneImagePrompt(opts: {
  category: SceneCategory;
  productName?: string | null;
  sku?: string | null;
  themeHint?: string | null; // the post's daily_theme — leans the scene's mood
  month?: number; // 0-indexed; injectable for tests
}): string {
  const { category, productName, sku, themeHint } = opts;
  const month = opts.month ?? new Date().getMonth();
  const product = productName?.trim() || sku?.trim() || 'PECRON power station';
  const scene =
    (category && SCENE_BY_CATEGORY[category]) || seasonalDefaultScene(month);
  // Soft nudge so the image matches the post's angle — as setting/mood ONLY,
  // never rendered as text in the image.
  const themeLine = themeHint?.trim()
    ? `Subtly reflect the post's angle ("${themeHint.trim()}") through setting and mood only — never as text in the image. `
    : '';

  return [
    `${themeLine}Professional e-commerce marketing photo of the ${product} (match the reference`,
    `image EXACTLY: same shape, color, screen, ports, labels, logo and proportions;`,
    `the product is the hero, facing camera). Scene: ${scene}. Style: high-end`,
    `commercial product photography, photorealistic, cinematic soft natural light,`,
    `shallow depth of field. Leave clean negative space in the upper third for a`,
    `price/offer overlay added later.`,
    `REALISM RULES (strict): NO visible power cords or cables anywhere; do NOT`,
    `connect any cable to appliances; no wires from appliances; keep buttons and`,
    `ports physically plausible; natural shadows and reflections; only ONE product`,
    `in frame, no duplicates.`,
    `PHYSICAL PLAUSIBILITY: this is a HEAVY unit — place it ON THE FLOOR or a sturdy`,
    `low surface (hearth, cabinet base, truck bed, ground), never on a fragile table`,
    `or thin shelf. Respect real scale (roughly knee-to-shin height next to`,
    `furniture). Grounded contact shadows, real materials — not glossy/floaty CGI.`,
    `Negative: no text, no watermark, no extra logos, no distorted or warped product,`,
    `no warped/changed labels, no morphing logo, no fabricated or duplicated parts,`,
    `no people, no overlay text, no floating objects.`,
  ].join(' ');
}
