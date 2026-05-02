# KPI definitions for Sol marketing

The HubSpot 2026 survey's top 5 marketing KPIs: lead quality, lead-to-customer conversion, marketing ROI, CAC, and lead generation volume. All five apply to Sol, but the formulas and signals are WhatsApp-specific. Definitions here.

Build one dashboard query per KPI. Review weekly. Review daily during a campaign launch.

---

## 1. Lead quality / MQL rate

**Definition:** percentage of inbound conversations in a period that show genuine buying intent.

**Formula:**
```
mql_rate = count(conversations where intent_score >= threshold) / count(conversations)
```

**How `intent_score` is computed:** the cheap version is keyword match on the user's first 3 messages — words like *precio*, *comprar*, *cuánto*, *envío*, *disponible*. The better version is asking Sol's own LLM to classify each conversation start (1–5) and writing the score back. See `scripts/conversation-outcomes.sql` for the schema.

**What "good" looks like:** highly variable by traffic source. Track baselines per source (organic, paid, Luz campaign, AI referral) — the HubSpot 2026 survey found 58% of marketers see AI-referred traffic as significantly higher intent. If Sol's AI-referred traffic isn't scoring higher than organic, something is wrong (probably attribution).

**Dashboard query pattern:**
```sql
select
  date_trunc('day', c.created_at) as day,
  count(*) as conversations,
  count(*) filter (where c.intent_score >= 4) as mqls,
  round(100.0 * count(*) filter (where c.intent_score >= 4) / nullif(count(*), 0), 1) as mql_pct
from conversations c
where c.created_at >= now() - interval '30 days'
group by 1
order by 1 desc;
```

---

## 2. Lead-to-customer conversion

**Definition:** percentage of inbound conversations that result in a purchase within 7 days.

**Formula:**
```
conversion_rate = count(distinct customers with order within 7d of conversation_start) 
                / count(distinct customers with conversation_start)
```

**Why 7 days:** WhatsApp conversions are usually fast. A 30-day window includes too much noise from other channels.

**What "good" looks like:** depends on Oiikon's product category and price point. Track it; don't benchmark against generic numbers. The HubSpot 2026 survey found AI-referred visitors convert 3× better than the previous baseline — if Sol is the closer for AI-referred traffic, expect this number to be the strongest in any channel report.

**Dashboard query pattern:**
```sql
with starts as (
  select customer_id, min(created_at) as first_msg_at
  from conversations
  where created_at >= now() - interval '60 days'
  group by 1
)
select
  date_trunc('week', s.first_msg_at) as week,
  count(*) as conversations,
  count(*) filter (where exists (
    select 1 from orders o
    where o.customer_id = s.customer_id
      and o.created_at between s.first_msg_at and s.first_msg_at + interval '7 days'
  )) as converted,
  round(100.0 * count(*) filter (where exists (
    select 1 from orders o
    where o.customer_id = s.customer_id
      and o.created_at between s.first_msg_at and s.first_msg_at + interval '7 days'
  )) / nullif(count(*), 0), 1) as conv_pct
from starts s
group by 1
order by 1 desc;
```

---

## 3. WhatsApp CAC (cost to acquire a customer via Sol)

**Definition:** total cost of running Sol over a period, divided by net new customers acquired in that period whose first interaction was via Sol.

**Formula:**
```
whatsapp_cac = (meta_conversation_cost + anthropic_cost)
              / new_customers_first_touched_via_sol
```

**Cost components:**
- **Meta conversation cost:** per outbound conversation (24h window) initiated by a marketing or utility template. Varies by destination country. Pull from Meta WhatsApp Manager billing or estimate from `meta_conversations_initiated` × per-region rate.
- **Anthropic cost:** total tokens (input + output) per conversation × per-model rate. Log token counts in `conversations.tokens_used` per call.

**Schema requirements:** track `tokens_used` and `meta_conversations_initiated` on every conversation. Without these, CAC is guesswork.

**Dashboard query pattern:**
```sql
select
  date_trunc('month', c.created_at) as month,
  sum(c.tokens_used * 0.000003) + sum(c.meta_conversations_initiated * 0.025) as estimated_cost_usd,
  count(distinct cust.id) filter (
    where cust.first_touch_channel = 'whatsapp'
      and cust.first_purchase_at between date_trunc('month', c.created_at)
                                     and date_trunc('month', c.created_at) + interval '1 month'
  ) as new_customers,
  round((sum(c.tokens_used * 0.000003) + sum(c.meta_conversations_initiated * 0.025))
       / nullif(count(distinct cust.id) filter (where cust.first_touch_channel = 'whatsapp'), 0), 2) as cac_usd
from conversations c
left join customers cust on cust.id = c.customer_id
where c.created_at >= now() - interval '6 months'
group by 1
order by 1 desc;
```

(Replace the magic-number rates with current Anthropic prices and the Meta per-conversation rate for each destination country — Meta marketing conversations run roughly $0.025 in US/CA, $0.04 in MX, $0.06 in ES, varying elsewhere.)

---

## 4. Response time

**Definition:** median seconds from inbound message → Sol's first reply.

**Formula:**
```
response_time_p50 = percentile_cont(0.5) within group (order by reply.created_at - inbound.created_at)
```

**Why it matters:** Sol's value over a human-staffed inbox is speed. If response time creeps above ~5 seconds for routine messages, something has regressed (cold starts, LLM latency, queue depth). HubSpot's data on AI-referred high-intent traffic only matters if Sol catches them while they're still in-buying-mode.

**Dashboard query pattern:**
```sql
with paired as (
  select
    m.id as inbound_id,
    m.created_at as inbound_at,
    (
      select min(r.created_at)
      from messages r
      where r.conversation_id = m.conversation_id
        and r.direction = 'outbound'
        and r.created_at > m.created_at
    ) as first_reply_at
  from messages m
  where m.direction = 'inbound'
    and m.created_at >= now() - interval '7 days'
)
select
  date_trunc('hour', inbound_at) as hour,
  count(*) as inbounds,
  percentile_cont(0.5) within group (order by extract(epoch from first_reply_at - inbound_at)) as p50_seconds,
  percentile_cont(0.95) within group (order by extract(epoch from first_reply_at - inbound_at)) as p95_seconds
from paired
where first_reply_at is not null
group by 1
order by 1 desc;
```

---

## 5. Per-campaign ROI

**Definition:** revenue attributed to a specific outbound campaign, divided by the campaign's total cost.

**Formula:**
```
campaign_roi = revenue_attributed / campaign_cost
```

**Attribution rule:** an order is attributed to a campaign if the customer's `last_campaign_id` was set by that campaign and the order happened within 7 days of the send.

**Schema requirements:** every outbound send writes `customers.last_campaign_id` and `customers.last_campaign_sent_at`. The `campaigns` table tracks total send cost.

**Dashboard query pattern:**
```sql
select
  cmp.id,
  cmp.name,
  cmp.sent_at,
  cmp.recipients_count,
  cmp.cost_usd,
  count(distinct o.id) as attributed_orders,
  coalesce(sum(o.total_amount), 0) as attributed_revenue,
  round(coalesce(sum(o.total_amount), 0) / nullif(cmp.cost_usd, 0), 2) as roi_multiple
from campaigns cmp
left join customers cust on cust.last_campaign_id = cmp.id
left join orders o
  on o.customer_id = cust.id
 and o.created_at between cmp.sent_at and cmp.sent_at + interval '7 days'
where cmp.sent_at >= now() - interval '90 days'
group by 1, 2, 3, 4, 5
order by cmp.sent_at desc;
```

---

## Pair every short-term metric with a 30-day retention metric

A campaign that boosts week-1 conversion but spikes opt-outs is net-negative. Always look at:

- **Opt-out rate per campaign:** opt-outs in 7d after send / recipients
- **Block / report rate:** users who blocked Sol after a campaign / recipients
- **30-day repeat purchase rate:** of campaign-attributed customers, what % bought again within 30d

If a high-ROI campaign also triples opt-out rate, it's borrowing from the future. Note it. Don't repeat it.

---

## Weekly review checklist

Every Monday:

- [ ] Pull last week's conversations, MQL rate, conversion rate.
- [ ] Pull every campaign sent in last 30 days, ROI, opt-out rate, repeat-buy rate.
- [ ] Pick 1 thing to change in the next 7 days. Log the hypothesis. (Examples: tighten POV section X, add personalization field Y, retire campaign template Z.)
- [ ] Compare to last week. Note what moved.
