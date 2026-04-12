import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';
import {
  sendWhatsAppMessage,
  sendOperatorAlert,
  verifyWebhookSignature,
} from '@/lib/whatsapp';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';

// Load agent prompt at module level (cache it)
const AGENT_PROMPT = fs.readFileSync(
  process.cwd() + '/AGENT_PROMPT.md',
  'utf-8'
);

// Rate limiting: Map<phone, lastAICallTimestamp>
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_SECONDS = 3;

// WhatsApp Cloud API webhook payload types
interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: {
    body: string;
  };
}

interface WhatsAppContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

interface WhatsAppWebhookValue {
  messages?: WhatsAppMessage[];
  contacts?: WhatsAppContact[];
}

interface WhatsAppWebhookChange {
  value: WhatsAppWebhookValue;
}

interface WhatsAppWebhookEntry {
  changes: WhatsAppWebhookChange[];
}

interface WhatsAppWebhookBody {
  entry: WhatsAppWebhookEntry[];
}

/**
 * GET Handler - Webhook Verification
 * Meta WhatsApp requires verification on subscription
 */
export async function GET(request: NextRequest) {
  console.log('[WEBHOOK] GET request received for verification');

  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    console.log('[WEBHOOK] Verification successful');
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  console.log('[WEBHOOK] Verification failed - invalid token or mode');
  return NextResponse.json(
    { error: 'Verification failed' },
    { status: 403 }
  );
}

/**
 * POST Handler - Incoming Messages
 * Process incoming WhatsApp messages from Meta
 */
export async function POST(request: NextRequest) {
  console.log('[WEBHOOK] POST request received for message');

  try {
    const body = (await request.json()) as WhatsAppWebhookBody;

    // Return 200 immediately for Meta
    const responsePromise = NextResponse.json(
      { status: 'ok' },
      { status: 200 }
    );

    // Process message asynchronously
    processWebhookMessage(body).catch((error) => {
      console.error('[WEBHOOK] Error processing message:', error);
    });

    return responsePromise;
  } catch (error) {
    console.error('[WEBHOOK] Error parsing webhook body:', error);
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400 }
    );
  }
}

/**
 * Main processing logic - runs asynchronously after 200 response
 */
async function processWebhookMessage(body: WhatsAppWebhookBody) {
  const supabase = createClient();
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Extract message and contact from Meta's webhook structure
  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

  if (!message || !contact) {
    console.log('[WEBHOOK] No message or contact found in payload');
    return;
  }

  const customerPhone = `+${message.from}`;
  const messageId = message.id;
  const messageType = message.type;
  const contactName = contact.profile?.name || 'Cliente';
  let messageText = message.text?.body || '';

  console.log(`[WEBHOOK] Processing message from ${customerPhone}: "${messageText}"`);

  // Only handle text messages
  if (messageType !== 'text') {
    console.log(`[WEBHOOK] Ignoring non-text message type: ${messageType}`);
    await sendWhatsAppMessage(
      customerPhone,
      'Por ahora solo puedo leer mensajes de texto.'
    );
    return;
  }

  // Remove the + from phone for operator command matching
  const phoneWithoutPlus = customerPhone.substring(1);
  const operatorPhone = process.env.OPERATOR_PHONE?.substring(1);

  // Check if this is an operator command
  if (operatorPhone && phoneWithoutPlus === operatorPhone) {
    await handleOperatorCommand(
      customerPhone,
      messageText,
      supabase
    );
    return;
  }

  // Regular customer message processing
  try {
    // Upsert conversation
    const { data: conversationData, error: conversationError } =
      await supabase
        .from('conversations')
        .upsert(
          {
            phone_number: customerPhone,
            customer_name: contactName,
          },
          {
            onConflict: 'phone_number',
          }
        )
        .select()
        .single();

    if (conversationError || !conversationData) {
      console.error('[WEBHOOK] Error upserting conversation:', conversationError);
      return;
    }

    const conversationId = conversationData.id;

    // Check if escalated
    if (conversationData.escalated) {
      console.log(
        `[WEBHOOK] Conversation is escalated, storing message and notifying operator`
      );
      // Just store the message
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'user',
        content: messageText,
      });

      // Notify operator
      await sendOperatorAlert(
        customerPhone,
        conversationData.escalation_reason || 'Escalated conversation',
        messageText
      );
      return;
    }

    // Store user message
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: messageText,
    });

    // Load conversation history (last 20 messages)
    const { data: messagesData, error: messagesError } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20);

    if (messagesError) {
      console.error('[WEBHOOK] Error loading message history:', messagesError);
      return;
    }

    // Check rate limit for AI calls
    const lastAICall = rateLimitMap.get(customerPhone) || 0;
    const now = Date.now();
    const timeSinceLastCall = (now - lastAICall) / 1000;

    if (timeSinceLastCall < RATE_LIMIT_SECONDS) {
      console.log(
        `[WEBHOOK] Rate limited for ${customerPhone} - skipping AI call`
      );
      return;
    }

    // Update rate limit
    rateLimitMap.set(customerPhone, now);

    // Build system prompt with current catalog
    const systemPrompt = await buildSystemPrompt(supabase);

    // Prepare conversation for AI
    interface AnthropicMessage {
      role: 'user' | 'assistant';
      content: string;
    }
    const conversationHistory: AnthropicMessage[] = (
      messagesData || []
    ).map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    console.log(`[WEBHOOK] Calling Claude with ${conversationHistory.length} messages in history`);

    // Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: conversationHistory,
    });

    const aiResponse =
      response.content[0]?.type === 'text' ? response.content[0].text : '';

    console.log(`[WEBHOOK] AI response: "${aiResponse}"`);

    // Check for handoff
    const handoffMatch = aiResponse.match(/\[HANDOFF:\s*(.+?)\]/);
    let customerFacingMessage = aiResponse;

    if (handoffMatch) {
      const handoffReason = handoffMatch[1].trim();
      customerFacingMessage = aiResponse
        .replace(/\[HANDOFF:\s*(.+?)\]/, '')
        .trim();

      console.log(`[WEBHOOK] Handoff detected: ${handoffReason}`);

      // Update conversation
      await supabase
        .from('conversations')
        .update({
          escalated: true,
          escalation_reason: handoffReason,
          status: 'escalated',
        })
        .eq('id', conversationId);

      // Insert into handoffs table
      await supabase.from('handoffs').insert({
        conversation_id: conversationId,
        reason: handoffReason,
        last_customer_message: messageText,
      });

      // Alert operator
      await sendOperatorAlert(customerPhone, handoffReason, messageText);
    }

    // Store assistant message
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: customerFacingMessage,
      handoff_detected: !!handoffMatch,
    });

    // Send response to customer
    await sendWhatsAppMessage(customerPhone, customerFacingMessage);
  } catch (error) {
    console.error('[WEBHOOK] Error processing customer message:', error);
  }
}

/**
 * Handle operator commands
 */
async function handleOperatorCommand(
  operatorPhone: string,
  command: string,
  supabase: ReturnType<typeof createClient>
) {
  console.log(`[OPERATOR] Command received: "${command}"`);

  const trimmedCommand = command.trim().toLowerCase();

  // /status command
  if (trimmedCommand === '/status') {
    const { data: activeConvos } = await supabase
      .from('conversations')
      .select('id')
      .eq('status', 'active');

    const { data: escalatedConvos } = await supabase
      .from('conversations')
      .select('id')
      .eq('status', 'escalated');

    const statusMessage = `📊 STATUS REPORT
Active conversations: ${activeConvos?.length || 0}
Escalated conversations: ${escalatedConvos?.length || 0}`;

    await sendWhatsAppMessage(operatorPhone, statusMessage);
    return;
  }

  // /bot +XXXX command
  const botMatch = trimmedCommand.match(/\/bot\s+\+?(\d+)/);
  if (botMatch) {
    const phoneToReactivate = `+${botMatch[1]}`;
    console.log(`[OPERATOR] Reactivating bot for ${phoneToReactivate}`);

    const { error } = await supabase
      .from('conversations')
      .update({
        escalated: false,
        status: 'active',
        escalation_reason: null,
      })
      .eq('phone_number', phoneToReactivate);

    if (error) {
      console.error('[OPERATOR] Error reactivating conversation:', error);
      await sendWhatsAppMessage(operatorPhone, '❌ Error reactivating bot');
      return;
    }

    await sendWhatsAppMessage(
      operatorPhone,
      `✅ Bot reactivated for ${phoneToReactivate}`
    );
    return;
  }

  console.log('[OPERATOR] Unknown command, ignoring');
}

/**
 * Build system prompt with current product catalog
 */
async function buildSystemPrompt(
  supabase: ReturnType<typeof createClient>
): Promise<string> {
  const { data: products, error } = await supabase
    .from('products')
    .select('sku, name, brand, price_usd, capacity_wh, output_watts, in_stock, description_es')
    .eq('in_stock', true);

  let catalogSection = '';

  if (!error && products && products.length > 0) {
    const catalogLines = products.map((product) => {
      const capacity = product.capacity_wh ? ` (${product.capacity_wh}Wh)` : '';
      const watts = product.output_watts ? ` ${product.output_watts}W` : '';
      return `- ${product.name}${capacity}${watts}: $${product.price_usd}`;
    });

    catalogSection = `

## CATÁLOGO ACTUALIZADO
Precios y disponibilidad actualizados (incluyen envío a Cuba):
${catalogLines.join('\n')}
`;
  }

  return `${AGENT_PROMPT}${catalogSection}`;
}
