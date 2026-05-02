// Outbound campaign send loop — Meta WhatsApp Cloud API
// ---------------------------------------------------------------------------
// Pattern for sending an approved Meta WhatsApp template message to a list
// of customers, with:
//   - opt-out and marketing-opt-in filtering (enforced upstream by the caller
//     when it builds the recipient list)
//   - throttling (1 msg/sec default)
//   - per-recipient failure handling (set do_not_message_until on certain
//     Meta error codes, continue the campaign)
//   - campaign attribution (write last_campaign_id on each successful send)
//   - cost tracking (per-conversation Meta marketing pricing, region-aware)
//   - per-attempt audit log: every send (success or failure) becomes a row in
//     `campaign_sends` with the Meta wamid for delivery-webhook reconciliation
//   - frozen audience snapshot in `campaign_recipients` for true audit and
//     resumability after a halted run
//   - dry-run mode for previewing audience + cost before any Meta call
//
// Stack: Meta WhatsApp Cloud API (Graph) — Twilio is no longer used. The
// runtime helpers live in `lib/whatsapp-meta.ts`; this script ships its own
// small `sendWhatsAppTemplate` wrapper so the skill is self-contained as a
// reference pattern.
//
// Design rules:
//   1. The caller is responsible for building the recipient list (typed
//      `Recipient[]`). It must already exclude opted-out, do-not-message-until
//      future, and (for marketing templates) non-marketing-opted-in rows.
//      Segments live as named SQL files in `scripts/segmentation-queries.sql`
//      and are executed via typed Supabase queries — NOT via a "run any SQL"
//      RPC. The earlier `run_segment_sql` pattern was SQL-injection-by-design.
//   2. The full audience snapshot is frozen into `campaign_recipients` at
//      the start of the run. Re-running the segment query later returns a
//      different audience; only the frozen list is the audit truth.
//   3. last_campaign_id on the customer row is set per-successful-send, NOT
//      in bulk before the loop. Bulk-tagging falsely attributes future
//      organic inbound replies from recipients we never actually messaged.
//   4. Every Meta call (success or failure) lands in `campaign_sends` with
//      the wamid (success) or the Meta error code (failure). Delivery-status
//      webhooks join back on wamid.
//   5. On a single Meta error, do NOT abort the whole campaign. Log and
//      move on. Abort only on repeated 5xx from Graph (auth issues, outage).
//   6. STOP/BAJA/CANCELAR opt-out is enforced at the recipient-build step.
//      The webhook (hardening skill) catches it on inbound; this script
//      respects it on outbound by trusting the recipient list.
//   7. Always run with `dryRun: true` first on a new segment to confirm
//      audience size, sample params, and estimated cost before spending
//      real money.
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const META_PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID!;
const META_ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN!;

const PER_SEND_DELAY_MS = 1000;                              // 1 msg/sec default
const ABORT_ON_CONSECUTIVE_5XX = 5;                          // safety brake

// Per-conversation Meta marketing pricing in USD. Meta bills per conversation
// (24h window), not per message. Rates vary by destination country — this is
// a coarse default; replace with a region map or a Meta billing pull for real
// post-mortem accounting.
//
// Indicative 2026 rates (USD per marketing conversation):
//   US/CA ≈ $0.025, MX ≈ $0.0436, ES ≈ $0.0615, BR ≈ $0.0625
//   Cuba and most LATAM unmetered/IP-routed → assume US rate as floor.
const PER_CONVERSATION_COST_USD = 0.025;

export interface Recipient {
  customer_id: string;
  /** E.164, e.g. "+15551234567". The "+" is stripped before Graph. */
  phone: string;
  first_name: string | null;
  language: string | null;
}

export interface CampaignInput {
  /** Human-readable campaign name, e.g. "abandoned-cart-2026-04". */
  name: string;
  /** Approved Meta template name, e.g. "abandoned_cart_v2". */
  templateName: string;
  /** Template language code, e.g. "es", "en_US". */
  templateLanguage: string;
  templateCategory: "utility" | "marketing" | "authentication";
  /**
   * Identifier for the segment that produced this audience (e.g.
   * "abandoned-cart"). Stored on the campaign row for audit. NOT a SQL
   * string — segments are typed queries owned by the caller.
   */
  segmentName: string;
  /**
   * Pre-built recipient list. Caller is responsible for opt-out filtering,
   * marketing-opt-in checks, and do-not-message-until exclusion. Pass a
   * function so the load is cheap on dry-run abort and consistent with the
   * snapshot-once design rule.
   */
  loadRecipients: () => Promise<Recipient[]>;
  /**
   * Returns the body parameters for one recipient, in the order they appear
   * in the template body (`{{1}}`, `{{2}}`, ...). Header / button parameters
   * not yet supported by this helper.
   */
  templateBodyParams: (recipient: Recipient) => string[];
  /** What we expect — for the weekly review. */
  hypothesis: string;
  /** 'eduardo' | 'luz' | … */
  sentBy: string;
  /** Preview audience + cost; no Meta calls, no DB writes. */
  dryRun?: boolean;
}

export interface CampaignResult {
  /** null on dry-run (no row inserted). */
  campaignId: string | null;
  recipientsAttempted: number;
  successes: number;
  failures: number;
  costEstimateUsd: number;
  dryRun: boolean;
  /** First recipient's body parameters, for dry-run preview. */
  sampleBodyParams?: string[];
}

/**
 * Run an outbound Meta WhatsApp template campaign end-to-end.
 *
 * The caller pre-builds the recipient list (typed, already filtered for
 * opt-out / marketing-opt-in / DNDM). This function does NOT add safety
 * filters — it trusts the list.
 */
export async function runCampaign(input: CampaignInput): Promise<CampaignResult> {
  // 1. Load the audience snapshot.
  const recipients = await input.loadRecipients();
  if (recipients.length === 0) {
    throw new Error("Recipient list is empty. Aborting before any send.");
  }

  // 2. Dry-run: preview audience size, sample params, and estimated cost.
  // No campaign row, no customer mutations, no Meta calls.
  if (input.dryRun) {
    const sample = input.templateBodyParams(recipients[0]);
    const estimated = recipients.length * PER_CONVERSATION_COST_USD;
    console.log(
      `[dry-run ${input.name}] segment=${input.segmentName} ` +
        `${recipients.length} recipients, ~$${estimated.toFixed(2)} est. cost ` +
        `(${input.templateCategory}). ` +
        `Template: ${input.templateName} (${input.templateLanguage}). ` +
        `Sample body params: ${JSON.stringify(sample)}`,
    );
    return {
      campaignId: null,
      recipientsAttempted: recipients.length,
      successes: 0,
      failures: 0,
      costEstimateUsd: estimated,
      dryRun: true,
      sampleBodyParams: sample,
    };
  }

  // 3. Insert the campaign row up front so attribution works even on failure.
  const { data: campaignRow, error: cmpErr } = await supabase
    .from("campaigns")
    .insert({
      name: input.name,
      template_name: input.templateName,
      template_language: input.templateLanguage,
      template_category: input.templateCategory,
      segment_name: input.segmentName,
      recipients_count: recipients.length,
      sent_at: new Date().toISOString(),
      sent_by: input.sentBy,
      hypothesis: input.hypothesis,
    })
    .select()
    .single();
  if (cmpErr) throw new Error(`Campaign insert failed: ${cmpErr.message}`);
  if (!campaignRow) throw new Error("Campaign insert returned no row.");

  const campaignId = campaignRow.id;
  const sentAt = new Date().toISOString();

  // 4. Freeze the audience into campaign_recipients so the audit is durable.
  // Even if the loop aborts, the full intended list is recoverable.
  const recipientsRows = recipients.map((r) => ({
    campaign_id: campaignId,
    customer_id: r.customer_id,
  }));
  const { error: rcptErr } = await supabase
    .from("campaign_recipients")
    .insert(recipientsRows);
  if (rcptErr) {
    throw new Error(`campaign_recipients insert failed: ${rcptErr.message}`);
  }

  // 5. Send loop with throttle + failure handling. Tag last_campaign_id
  // per-successful-send (NOT in bulk before the loop) so an aborted run
  // doesn't falsely attribute future organic inbound from recipients we
  // never actually sent to.
  let successes = 0;
  let failures = 0;
  let consecutive5xx = 0;

  for (const r of recipients) {
    try {
      const wamid = await sendWhatsAppTemplate({
        to: r.phone,
        templateName: input.templateName,
        languageCode: input.templateLanguage,
        bodyParams: input.templateBodyParams(r),
      });
      successes++;
      consecutive5xx = 0;
      await Promise.all([
        supabase
          .from("customers")
          .update({ last_campaign_id: campaignId, last_campaign_sent_at: sentAt })
          .eq("id", r.customer_id),
        supabase.from("campaign_sends").insert({
          campaign_id: campaignId,
          customer_id: r.customer_id,
          status: "success",
          wamid,
        }),
      ]);
    } catch (err: unknown) {
      failures++;
      await handleSendFailure(campaignId, r, err);
      const status = (err as { httpStatus?: number })?.httpStatus ?? 0;
      if (status >= 500) consecutive5xx++;
      else consecutive5xx = 0;
      if (consecutive5xx >= ABORT_ON_CONSECUTIVE_5XX) {
        console.error(
          `[campaign ${input.name}] aborting after ${consecutive5xx} consecutive 5xx from Graph`,
        );
        break;
      }
    }
    await sleep(PER_SEND_DELAY_MS);
  }

  // 6. Cost estimate (rough — replace with a Meta billing pull or a
  // region-aware rate map for real post-mortem accounting).
  const estimatedCostUsd = successes * PER_CONVERSATION_COST_USD;
  await supabase
    .from("campaigns")
    .update({ cost_usd: estimatedCostUsd })
    .eq("id", campaignId);

  return {
    campaignId,
    recipientsAttempted: recipients.length,
    successes,
    failures,
    costEstimateUsd: estimatedCostUsd,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API — minimal template-send wrapper
// ---------------------------------------------------------------------------
// Mirrors the runtime helper at lib/whatsapp-meta.ts. Returns the wamid on
// success so the campaign loop can persist it for delivery-webhook joining.
// Promotes Graph errors to a typed MetaSendError so the loop can branch on
// `.code` and `.httpStatus`.

interface MetaTemplatePayload {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: Array<{
      type: "body";
      parameters: Array<{ type: "text"; text: string }>;
    }>;
  };
}

interface MetaSendResponse {
  messages?: Array<{ id?: string }>;
}

class MetaSendError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: number | null,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "MetaSendError";
  }
}

async function sendWhatsAppTemplate(args: {
  to: string;
  templateName: string;
  languageCode: string;
  bodyParams: string[];
}): Promise<string> {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  const payload: MetaTemplatePayload = {
    messaging_product: "whatsapp",
    to: args.to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: args.templateName,
      language: { code: args.languageCode },
    },
  };
  if (args.bodyParams.length > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: args.bodyParams.map((text) => ({ type: "text", text })),
      },
    ];
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const raw = await res.text();
    let code: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: number } };
      code = parsed?.error?.code ?? null;
    } catch {
      // body wasn't JSON — leave code null
    }
    throw new MetaSendError(
      `Meta WA template send failed ${res.status}: ${raw}`,
      res.status,
      code,
      raw,
    );
  }
  const json = (await res.json()) as MetaSendResponse;
  const wamid = json.messages?.[0]?.id;
  if (!wamid) {
    throw new MetaSendError(
      "Meta WA send returned no wamid",
      res.status,
      null,
      JSON.stringify(json),
    );
  }
  return wamid;
}

/**
 * Handle a single send failure. Records the attempt in campaign_sends and
 * applies per-customer cooldowns based on Meta error code. Codes worth
 * special-casing
 * (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes):
 *
 *   131026 — Message undeliverable (recipient not on WhatsApp / number not
 *            reachable). Mark do_not_message_until = +30d.
 *   131047 — Re-engagement message — outside 24h window without a template.
 *            Means the call wasn't actually a template send. Log only.
 *   131048 — Spam rate limit hit on the sender. Mark +7d.
 *   131056 — Pair rate limit (too many messages to a single user). Mark +7d.
 *   130472 — User in marketing-opt-out experiment (Meta-imposed). Treat as
 *            opted_out so we never DM them again with marketing.
 *   133010 — Phone number not registered with WhatsApp. Mark +30d.
 *
 * Other errors (template structure, params mismatch, generic 100/etc.) are
 * logged only — they're sender-side bugs, not customer-side issues.
 */
async function handleSendFailure(
  campaignId: string,
  r: Recipient,
  err: unknown,
): Promise<void> {
  const isMetaErr = err instanceof MetaSendError;
  const code = isMetaErr ? err.code : null;
  const raw = isMetaErr ? err.raw : String(err);
  console.warn(`[campaign] send to ${r.customer_id} failed:`, code, err);

  await supabase.from("campaign_sends").insert({
    campaign_id: campaignId,
    customer_id: r.customer_id,
    status: "failed",
    meta_error_code: code,
    meta_error_raw: raw,
  });

  switch (code) {
    case 130472:
      await supabase
        .from("customers")
        .update({ opted_out: true, opted_out_at: new Date().toISOString() })
        .eq("id", r.customer_id);
      return;
    case 131026:
    case 133010:
      await supabase
        .from("customers")
        .update({
          do_not_message_until: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        })
        .eq("id", r.customer_id);
      return;
    case 131048:
    case 131056:
      await supabase
        .from("customers")
        .update({
          do_not_message_until: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        })
        .eq("id", r.customer_id);
      return;
    default:
      // Logged in campaign_sends; don't sideline the customer for transient
      // or sender-side errors.
      return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Example usage ----
//
// // Build the recipient list with a typed Supabase query — never a SQL string.
// // The query lives in scripts/segmentation-queries.sql as a documented view
// // or named RPC; here we just consume it.
// async function loadAbandonedCartRecipients(): Promise<Recipient[]> {
//   const { data, error } = await supabase
//     .from("v_abandoned_cart_marketable")  // view that already filters opt-out etc.
//     .select("customer_id, phone, first_name, language")
//     .limit(200);
//   if (error) throw error;
//   return data as Recipient[];
// }
//
// const baseInput = {
//   name: "abandoned-cart-2026-04",
//   templateName: "abandoned_cart_v2",
//   templateLanguage: "es",
//   templateCategory: "marketing" as const,
//   segmentName: "abandoned-cart",
//   loadRecipients: loadAbandonedCartRecipients,
//   templateBodyParams: (r) => [r.first_name ?? ""],
//   hypothesis:
//     "High-intent cart abandoners convert >5% within 7d when given " +
//     "a low-friction nudge (no discount). Goal: 5% conversion, <1% opt-out.",
//   sentBy: "eduardo",
// };
//
// // Step 1 — ALWAYS dry-run first. Confirms audience size, params, est. cost.
// const preview = await runCampaign({ ...baseInput, dryRun: true });
// console.log(preview);
// // { campaignId: null, recipientsAttempted: 134, ..., costEstimateUsd: 3.35,
// //   dryRun: true, sampleBodyParams: ["Eduardo"] }
//
// // Step 2 — once Eduardo/Luz approves the preview, run for real.
// const result = await runCampaign(baseInput);
// console.log(result);
// // { campaignId: '...', recipientsAttempted: 134, successes: 131, failures: 3,
// //   costEstimateUsd: 3.27, dryRun: false }
