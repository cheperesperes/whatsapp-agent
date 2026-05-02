// Personalization prompt builder
// ---------------------------------------------------------------------------
// Pattern for assembling Sol's system prompt with brand POV + customer context.
// Drop into Sol's webhook handler. Adapt types and table names to match the
// actual schema.
//
// Design rules:
//   1. The brand POV is read from BRAND_POV.md at startup, not per request.
//      Editing the POV requires a redeploy; that's intentional friction.
//   2. Customer context is injected per request, only fields that exist.
//      Missing fields are *omitted*, never faked.
//   3. The intent bucket from Tier 3 personalization is a single tag.
//   4. The prompt is built deterministically — no LLM in the loop here.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

// Load BRAND_POV.md once at module load. If it changes, redeploy.
const BRAND_POV = readFileSync(
  path.resolve(process.cwd(), "BRAND_POV.md"),
  "utf-8",
);

export type IntentBucket =
  | "high_intent"
  | "browsing"
  | "repeat_buyer"
  | "dormant"
  | "new"
  | "opted_out";

export interface CustomerContext {
  first_name?: string | null;
  language?: string | null;             // 'es' | 'en' | …
  customer_since?: Date | null;
  last_purchased_product?: string | null;
  last_viewed_product?: string | null;
  cart_items_count?: number | null;
  total_lifetime_orders?: number | null;
  bucket: IntentBucket;
  last_campaign_id?: string | null;
  last_campaign_name?: string | null;   // e.g. "abandoned-cart-2026-04"
}

// Per-bucket guidance. Tone-shaping hints, not hard scripts — Sol's underlying
// brand POV should still come through. Keep these short.
const BUCKET_GUIDANCE: Record<IntentBucket, string> = {
  high_intent:
    "This customer is showing buying signals (cart, recent product view, or active inquiry). " +
    "Be helpful and direct. Answer their question, then make it frictionless to purchase. " +
    "Offer a payment link if it fits naturally. Do NOT push hard — they're already interested; " +
    "pushing breaks trust.",
  browsing:
    "This customer is exploring. Educate, compare, recommend based on their context. " +
    "Don't push the sale. Trust that a good answer now earns the purchase later.",
  repeat_buyer:
    "Returning customer with 2+ orders. Recognize the relationship without being saccharine. " +
    "You can reference past purchases naturally. Complementary recommendations are welcome.",
  dormant:
    "Hasn't purchased in 90+ days and has low recent activity. Lead with curiosity — what " +
    "changed, what would be useful — not with a discount. A discount before a conversation " +
    "trains the customer to wait for the next one.",
  new:
    "First contact, opted in within the last week. Welcome them, anchor on a single product " +
    "or value the brand stands for, invite them to ask anything. Don't overload.",
  opted_out:
    "This customer opted out of marketing. Sol must NOT initiate marketing-flavored content. " +
    "If they've reached out, treat it as a service question only. If they want to re-opt-in, " +
    "confirm explicitly before resuming any marketing tone.",
};

/**
 * Build the system prompt for a single Sol turn.
 * Keep this function pure: same inputs → same string. No I/O beyond the
 * BRAND_POV file read at module load.
 */
export function buildSystemPrompt(ctx: CustomerContext): string {
  const lines: string[] = [];

  // ---- 1. Brand POV (the foundation, every turn) ----
  lines.push("# Oiikon brand POV (do not deviate)");
  lines.push("");
  lines.push(BRAND_POV.trim());
  lines.push("");

  // ---- 2. Bucket guidance ----
  lines.push("# This customer's intent bucket");
  lines.push("");
  lines.push(`<intent>${ctx.bucket}</intent>`);
  lines.push(BUCKET_GUIDANCE[ctx.bucket]);
  lines.push("");

  // ---- 3. Customer context (only fields present) ----
  const ctxLines: string[] = [];
  if (ctx.first_name) ctxLines.push(`- Name: ${ctx.first_name}`);
  if (ctx.language) ctxLines.push(`- Preferred language: ${ctx.language}`);
  if (ctx.customer_since)
    ctxLines.push(`- Customer since: ${ctx.customer_since.toISOString().slice(0, 10)}`);
  if (ctx.total_lifetime_orders != null)
    ctxLines.push(`- Lifetime orders: ${ctx.total_lifetime_orders}`);
  if (ctx.last_purchased_product)
    ctxLines.push(`- Last purchased: ${ctx.last_purchased_product}`);
  if (ctx.last_viewed_product)
    ctxLines.push(`- Recently viewed: ${ctx.last_viewed_product}`);
  if (ctx.cart_items_count != null && ctx.cart_items_count > 0)
    ctxLines.push(`- Items in cart right now: ${ctx.cart_items_count}`);
  if (ctx.last_campaign_name)
    ctxLines.push(
      `- Replying to campaign: ${ctx.last_campaign_name}` +
        " (use this only if they bring it up; don't lead with it)",
    );

  if (ctxLines.length > 0) {
    lines.push("# What we know about this customer");
    lines.push("");
    lines.push(...ctxLines);
    lines.push("");
    lines.push(
      "Use this naturally. If a field is missing, do NOT make one up. " +
        "If a field is creepy to mention without context, ask a question that " +
        "lets the customer confirm rather than presenting it as fact.",
    );
    lines.push("");
  }

  // ---- 4. Hard rules ----
  lines.push("# Hard rules (non-negotiable)");
  lines.push("");
  lines.push(
    "- Never identify as an AI, language model, or assistant. You are Sol.",
  );
  lines.push(
    "- Never invent product details, prices, stock, or shipping times. If unsure, ask or escalate.",
  );
  lines.push(
    "- Never market to a customer whose intent bucket is `opted_out`.",
  );
  lines.push(
    "- Reply in the customer's language. If unsure, match their last message.",
  );
  lines.push(
    "- Keep replies under 60 words unless the question genuinely needs more.",
  );

  return lines.join("\n");
}

// ---- Example usage (in the webhook handler) ----
//
// import Anthropic from "@anthropic-ai/sdk";
// const anthropic = new Anthropic();
//
// const ctx = await loadCustomerContext(supabase, customerId);
// const systemPrompt = buildSystemPrompt(ctx);
//
// const response = await anthropic.messages.create({
//   model: "claude-sonnet-4-6",
//   max_tokens: 400,
//   system: systemPrompt,
//   messages: conversationHistory,
// });
//
// // Log tokens for CAC tracking — see kpi-definitions.md.
// await supabase.from("conversations").update({
//   tokens_used: (existing ?? 0) + response.usage.input_tokens + response.usage.output_tokens,
// }).eq("id", conversationId);
