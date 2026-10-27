import type Anthropic from '@anthropic-ai/sdk';

/**
 * All text blocks of a Messages API response, joined. Newer models can return
 * more than one content block (and the first one is not always text), so
 * reading only `content[0]` silently yields '' — which downstream turned into
 * the validator's fallback line on EVERY reply (prod incident 2026-10-27).
 */
export function textOf(response: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of response.content ?? []) {
    if (block && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  if (parts.length === 0 && (response.content?.length ?? 0) > 0) {
    console.warn('[anthropic] response had no text block; block types:', response.content.map((b) => b.type).join(','));
  }
  return parts.join('\n').trim();
}
