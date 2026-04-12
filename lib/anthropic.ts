import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Message } from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 500;

// Cache the agent prompt (read once at module load)
let _agentPromptCache: string | null = null;

function getAgentPrompt(): string {
  if (_agentPromptCache) return _agentPromptCache;

  try {
    const promptPath = join(process.cwd(), 'AGENT_PROMPT.md');
    _agentPromptCache = readFileSync(promptPath, 'utf-8');
    return _agentPromptCache;
  } catch {
    // Fallback minimal prompt if file can't be read
    return 'Eres Sol, el asistente virtual de Oiikon. Ayuda a los clientes con información sobre productos de energía solar en español.';
  }
}

export interface SolResponse {
  message: string;
  handoffReason: string | null;
}

/**
 * Call Claude to generate Sol's response.
 * Returns the customer-facing message and any detected handoff reason.
 */
export async function generateSolResponse(
  conversationHistory: Message[],
  newUserMessage: string,
  productCatalog: string
): Promise<SolResponse> {
  const basePrompt = getAgentPrompt();

  // Build the full system prompt including current product catalog
  const systemPrompt = `${basePrompt}

${productCatalog}

FECHA ACTUAL: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
`;

  // Build messages array from history
  const messages: Anthropic.MessageParam[] = conversationHistory.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Add the new user message
  messages.push({ role: 'user', content: newUserMessage });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    },
    {
      headers: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    }
  );

  const rawText =
    response.content[0]?.type === 'text' ? response.content[0].text : '';

  // Detect [HANDOFF: reason] tag
  const handoffMatch = rawText.match(/\[HANDOFF:\s*([^\]]+)\]/i);
  const handoffReason = handoffMatch ? handoffMatch[1].trim() : null;

  // Strip the tag from customer-facing message
  const customerMessage = rawText.replace(/\[HANDOFF:\s*[^\]]+\]/gi, '').trim();

  return { message: customerMessage, handoffReason };
}
