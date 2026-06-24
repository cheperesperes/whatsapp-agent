/**
 * Vetted product demo/review videos — the proof Sol shares at the doubt moment
 * ("¿está seguro que levanta la nevera?" / "are you sure it runs my A/C?").
 *
 * The closing playbook tells Sol to PROVE capability, not assert it. A real
 * third-party clip of the EXACT unit running the appliance is the strongest
 * proof there is.
 *
 * HARD GUARDRAIL — Sol never types a raw video URL. It emits a
 * `[PROOF_VIDEO:SKU]` tag and the dispatch below swaps in the ONE approved URL
 * for that SKU (or strips the tag if there's no curated video). So a wrong /
 * competitor / hallucinated link can NEVER reach a customer — only what's
 * product-matched and vetted here.
 *
 * Each URL was verified to be a review/demo of THAT EXACT model (the title
 * names the model; F5000LFP additionally confirmed via page fetch). Re-vet
 * before adding or changing a SKU — a mismatched clip destroys trust.
 */
export const PROOF_VIDEOS: Readonly<Record<string, string>> = {
  // E3600LFP running a full-size refrigerator — "Portable Power Station Vs My
  // Refrigerator (pecron e3600lfp actual test)". The fridge-doubt case.
  E3600LFP: 'https://www.youtube.com/watch?v=rRqE6OTJ0I4',
  // F5000LFP review (page-fetch confirmed it's the F5000LFP, not F3000) —
  // runs a 15,000 BTU RV A/C. The A/C / whole-home-doubt case.
  F5000LFP: 'https://www.youtube.com/watch?v=ECNvmhUDaWI',
  // E2000LFP load test & review — the accessible entry unit.
  E2000LFP: 'https://www.youtube.com/watch?v=AgkUlXLIUXM',
};

/** Approved demo/review video URL for a SKU, or null if none is curated. */
export function getProofVideo(sku: string | null | undefined): string | null {
  if (!sku) return null;
  return PROOF_VIDEOS[sku.trim().toUpperCase()] ?? null;
}

/** The SKUs that currently have a vetted demo, for the prompt rule. */
export const PROOF_VIDEO_SKUS = Object.keys(PROOF_VIDEOS);

const PROOF_VIDEO_TAG = /\[\[?\s*PROOF_VIDEO:\s*([A-Z0-9][A-Z0-9_\-./]*)\s*\]\]?/gi;

/**
 * Replace every `[PROOF_VIDEO:SKU]` tag in Sol's reply with the ONE approved
 * video URL for that SKU. A tag whose SKU has no curated video is removed
 * entirely — we never leak the raw tag and never send a wrong link.
 */
export function replaceProofVideoTags(text: string): string {
  if (!text) return text;
  return (
    text
      .replace(PROOF_VIDEO_TAG, (_match, sku: string) => getProofVideo(sku) ?? '')
      // Defense-in-depth: nuke any malformed / leftover PROOF_VIDEO marker so a
      // raw tag can never reach the customer.
      .replace(/\[\[?\s*PROOF_VIDEO\b[^\]]*\]\]?/gi, '')
  );
}
