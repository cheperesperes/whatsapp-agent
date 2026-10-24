// Turn-1 directive for web chats.
//
// The web widget shows a canned greeting before the visitor types anything.
// That greeting never reaches the DB, so on turn 1 Sol would otherwise say
// hello and introduce itself again (seen on the #340 preview: "¡Hola! Soy Sol…"
// twice in a row).
//
// The widget sends only a fixed signal — never the greeting text itself — so
// nothing a browser posts is copied into Sol's system prompt:
//   'sol'     → the greeting already named Sol + Oiikon + virtual assistant
//   'generic' → a greeting was shown but it did not name Sol (site override)

export type WidgetGreeted = 'sol' | 'generic';

export function parseWidgetGreeted(value: unknown): WidgetGreeted | null {
  return value === 'sol' || value === 'generic' ? value : null;
}

export function buildWidgetGreetingDirective(value: unknown): string {
  const greeted = parseWidgetGreeted(value);
  if (!greeted) return '';
  return [
    '## WIDGET GREETING ALREADY SHOWN (web only — overrides the turn-1 opener rule)',
    'The chat window already greeted this visitor before they typed.',
    'Do NOT say hello/hola again and do NOT open with an introduction. Start with the answer to their message.',
    greeted === 'sol'
      ? 'That greeting already said you are Sol, Oiikon\'s virtual assistant — do not repeat it. You may still weave in ONE credibility cue (e.g. free shipping across the USA) inside the answer if it fits naturally.'
      : 'That greeting did not name you, so add a short clause inside the answer that you are Sol, Oiikon\'s virtual assistant — no separate greeting line.',
  ].join('\n');
}

/** Same rule the widget uses to decide which signal to send. */
export function greetingNamesSol(greeting: string): boolean {
  return /\bsol\b/i.test(greeting) && /oiikon/i.test(greeting) && /(virtual|asistente|assistant)/i.test(greeting);
}
