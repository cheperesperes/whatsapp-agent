/**
 * Small, deterministic rules that make Sol behave like a person in chat.
 *
 * Measured on 2026-10-23 (Supabase, all chats since April): customers sent 72
 * bare closers ("gracias", "👍", "ok") and Sol answered 65 of them — often a
 * goodbye to a goodbye to a thumbs-up. A human stops once the chat is wrapped up.
 */

import type { Message } from './types';

const CLOSER_WORDS_RE =
  /^\s*(ok(ay)?|okey|oki|gracias|muchas gracias|mil gracias|ok gracias|gracias igualmente|igualmente|bendiciones|thanks|thank you|thank u|thx|ty|merci|mèsi|mesi)\s*[!.¡]*\s*$/i;
// Emoji / pictograph only (with skin tones, joiners, variation selectors).
const EMOJI_ONLY_RE = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]+$/u;

export function isEmojiOnly(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && EMOJI_ONLY_RE.test(t);
}

/** A message that only acknowledges or thanks — no question, no new info. */
export function isBareCloser(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 40) return false;
  if (isEmojiOnly(t)) return true;
  // "gracias 🙏", "ok 👍": strip trailing emoji, then match the words.
  const words = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, '').trim();
  return CLOSER_WORDS_RE.test(words);
}

// "ok" alone is an acknowledgment, not thanks — like a thumbs-up.
const PLAIN_OK_RE = /^\s*(ok(ay)?|okey|oki)\s*[!.]*\s*$/i;
// Sol already said goodbye — nothing left to answer.
const SOL_GOODBYE_RE =
  /(excelente d[ií]a|buen d[ií]a|feliz d[ií]a|hasta pronto|hasta luego|aqu[ií] estar[ée]|aqu[ií] estoy cuando|que lo disfrute|cu[ií]dese|have a (great|good|nice) day|talk soon|take care|here whenever you)/i;

function askedSomething(text: string): boolean {
  // Look only at the end of the message — that's where a real question sits.
  return /[?¿]/.test((text ?? '').slice(-240));
}

/**
 * Should Sol stay silent on this closer? `recent` = chronological messages
 * whose LAST element is the customer's current message (already stored).
 *
 * - Sol's last message asked something → reply ("ok" may be an answer).
 * - Emoji-only or a plain "ok" → silent (a person doesn't answer a thumbs-up).
 * - Sol's last message was already a goodbye → silent.
 * - A second closer in a row ("gracias" after "👍"/"gracias") → silent.
 * - Otherwise (first "gracias") → reply once; the prompt says say goodbye and stop.
 */
export function shouldStaySilentOnCloser(recent: Message[]): boolean {
  const chat = recent.filter((m) => m.role === 'user' || m.role === 'assistant');
  const current = chat.at(-1);
  if (!current || current.role !== 'user' || !isBareCloser(current.content)) return false;

  const prior = chat.slice(0, -1);
  const lastSol = [...prior].reverse().find((m) => m.role === 'assistant');
  if (!lastSol) return false; // first contact — always answer
  if (askedSomething(lastSol.content)) return false;
  if (isEmojiOnly(current.content)) return true;
  const words = current.content.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, '').trim();
  if (PLAIN_OK_RE.test(words)) return true;
  if (SOL_GOODBYE_RE.test(lastSol.content.slice(-160))) return true;

  const prevUser = [...prior].reverse().find((m) => m.role === 'user');
  return !!prevUser && isBareCloser(prevUser.content);
}
