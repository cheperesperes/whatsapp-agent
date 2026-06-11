# Sales pipeline — multi-day follow-up system

Sol's job doesn't end at the first reply: most sales close on follow-up. This
system works every quoted lead over days, automatically inside WhatsApp's 24h
window and manually after it.

## The ladder

| Touch | When | Who sends | What |
|---|---|---|---|
| Quote reply | instant | Sol (webhook) | price + link + photo, assumptive close |
| **Touch 1** | 2–6h silent | `/api/cron/sales-followup` (`:15` hourly) | "¿qué le pareció el X? le preparo su link de pago" — or the pay-link help nudge (`paylink-nudge`, `:30`) if a pay-link was sent |
| **Touch 2** | 18–23h silent | `/api/cron/send-followups` (`:00` hourly) | last free-form touch before the window closes |
| **Manual chase** | day 2–14 | Operator, from the WhatsApp app | `/dashboard/pipeline` queue — copy the suggested message, tap "Abrir en WhatsApp" |

The 18–23h window is measured from the **customer's last inbound message**
(that's what WhatsApp's free-form policy counts) — a nudge does not reset it.

## Hard safety rules (all enforced in code)

- Max **2 automated touches** per conversation, **≥10h apart** — ledger in the
  `sol_followups` table, double-send-proof across all three crons.
- Never after: a customer reply, an order (phone match), `converted_at`,
  opt-out, escalation, or a "cuba" mention (USA-only declined leads).
- Quiet hours: nothing 21:00–08:00 customer-local time.
- Every automated draft is deterministic (no LLM at send time) and makes no
  price/discount/stock claims that could have changed since the quote.
- Per-run caps: `SALES_FOLLOWUP_MAX_SEND` (25), `PAYLINK_NUDGE_MAX_SEND` (25),
  `FOLLOWUP_CRON_MAX_SEND` (50).

## Switches (Vercel env, project `whatsapp-agent`)

| Var | Default | Meaning |
|---|---|---|
| `SALES_FOLLOWUP_ENABLED` | **off → dry-run** | touch 1 for quoted leads. Set `true` to go live |
| `PAYLINK_NUDGE_ENABLED` | **off → dry-run** | touch 1 for pay-link leads. Set `true` to go live |
| `FOLLOWUP_CRON_ENABLED` | **on** | touch 2 (was already live pre-ladder) |

Dry-run = the cron runs, logs exactly who it WOULD message and the preview
text (`details.sent` in the response / Vercel logs), but sends nothing.
Review a day of dry-run output, then flip the env vars.

## The dashboard

`/dashboard/pipeline` — live stages over the last 14 days:

- 🔴 **Por responder** — the customer wrote last; a human/Sol owes a reply NOW.
- 🔥 **Calientes** — quoted, <24h silent, automated ladder active (shows which
  touch is next).
- ⏰ **Seguimiento manual** — window closed; suggested ES/EN copy + WhatsApp
  deep-link per lead. This is the daily 5-minute operator routine.
- 💰 **Convertidos** — phone-matched orders.

## Related

- Reply validator (`lib/validate-reply.ts`, PR #189) — every outbound passes
  the deterministic rule gate (no OOS pitches, no invented payment links).
- Closing playbook — AGENT_PROMPT.md "Paso 7" (assumptive close, real urgency
  only, think-it-over handler, F5000→E3600 price step-down).
