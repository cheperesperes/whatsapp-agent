-- Sol segmentation queries
-- ---------------------------------------------------------------------------
-- These are the SQL patterns Sol's backend uses to:
--   (a) compute the nightly "intent bucket" per customer (Tier 3 personalization)
--   (b) build campaign audiences for outbound sends
--
-- Adapt table/column names to match Oiikon's actual schema. The queries assume:
--   customers(id, phone, first_name, language, created_at, opted_out,
--             marketing_opt_in, last_campaign_id, last_campaign_sent_at,
--             do_not_message_until)
--   conversations(id, customer_id, created_at, intent_score)
--   messages(id, conversation_id, direction, created_at)
--   orders(id, customer_id, created_at, total_amount)
--   site_events(customer_id, event_type, occurred_at, product_id)
--
-- Schema migrations to add the columns above are in conversation-outcomes.sql.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- VIEW: nightly intent bucket per customer
-- ===========================================================================
-- Refresh nightly (e.g. via Supabase scheduled function or external cron).
-- Sol reads this view at conversation start to inject the bucket into the
-- system prompt.

create or replace view customer_intent_bucket as
with last_purchase as (
  select customer_id, max(created_at) as last_purchase_at, count(*) as total_orders
  from orders group by customer_id
),
recent_cart as (
  select customer_id, max(occurred_at) as last_cart_event_at
  from site_events
  where event_type = 'cart_added'
    and occurred_at >= now() - interval '48 hours'
  group by customer_id
),
recent_view as (
  select customer_id, max(occurred_at) as last_view_at
  from site_events
  where event_type = 'product_viewed'
    and occurred_at >= now() - interval '14 days'
  group by customer_id
),
recent_inbound as (
  select c.customer_id, max(m.created_at) as last_inbound_at
  from messages m
  join conversations c on c.id = m.conversation_id
  where m.direction = 'inbound'
    and m.created_at >= now() - interval '24 hours'
  group by c.customer_id
)
select
  cust.id as customer_id,
  case
    when cust.opted_out then 'opted_out'
    when rc.last_cart_event_at is not null
      or (rv.last_view_at is not null and ri.last_inbound_at is not null) then 'high_intent'
    when lp.total_orders >= 2 then 'repeat_buyer'
    when rv.last_view_at is not null then 'browsing'
    when lp.total_orders is null and cust.created_at >= now() - interval '7 days' then 'new'
    when lp.last_purchase_at < now() - interval '90 days'
      or (rv.last_view_at is null and lp.total_orders is null) then 'dormant'
    else 'browsing'
  end as bucket,
  rc.last_cart_event_at,
  rv.last_view_at,
  ri.last_inbound_at,
  lp.last_purchase_at,
  lp.total_orders
from customers cust
left join last_purchase lp on lp.customer_id = cust.id
left join recent_cart rc on rc.customer_id = cust.id
left join recent_view rv on rv.customer_id = cust.id
left join recent_inbound ri on ri.customer_id = cust.id;


-- ===========================================================================
-- SEGMENT: high-intent — abandoned cart in last 48h
-- ===========================================================================
-- Use case: a marketing-template campaign nudging cart completion.
-- Filters: opted-in for marketing, not opted out, not recently messaged.

select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language
from customers cust
join customer_intent_bucket b on b.customer_id = cust.id
where b.bucket = 'high_intent'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '7 days');


-- ===========================================================================
-- SEGMENT: dormant — no purchase in 90+ days
-- ===========================================================================
-- Use case: reactivation campaign.

select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language,
  lp.last_purchase_at
from customers cust
join customer_intent_bucket b on b.customer_id = cust.id
left join (
  select customer_id, max(created_at) as last_purchase_at from orders group by customer_id
) lp on lp.customer_id = cust.id
where b.bucket = 'dormant'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '30 days')
order by lp.last_purchase_at desc nulls last;


-- ===========================================================================
-- SEGMENT: repeat buyers — for upsell / cross-sell
-- ===========================================================================
-- Use case: announce a complementary product to the most engaged customers.

select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language,
  lp.total_orders,
  lp.last_purchase_at
from customers cust
join customer_intent_bucket b on b.customer_id = cust.id
join (
  select customer_id, count(*) as total_orders, max(created_at) as last_purchase_at
  from orders group by customer_id
) lp on lp.customer_id = cust.id
where b.bucket = 'repeat_buyer'
  and lp.total_orders >= 2
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
order by lp.total_orders desc, lp.last_purchase_at desc;


-- ===========================================================================
-- SEGMENT: new customers in welcome window
-- ===========================================================================
-- Use case: utility welcome flow (first 7 days).
-- Note: utility template, so marketing_opt_in is NOT required — but opted_out
-- still is.

select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language,
  cust.created_at
from customers cust
where cust.created_at >= now() - interval '7 days'
  and cust.opted_out = false
  and not exists (
    select 1 from messages m
    join conversations c on c.id = m.conversation_id
    where c.customer_id = cust.id
      and m.direction = 'outbound'
      and m.created_at >= cust.created_at
  );


-- ===========================================================================
-- ONE-SHOT USE-CASE BACKFILL
-- ===========================================================================
-- Run this once after deploying the use_case column. It infers a use_case for
-- each customer from three weak signals, in order of confidence:
--   1. self_reported  — keywords found in the customer's chat messages
--   2. inferred_from_zip — phone or shipping ZIP in a hurricane-belt or
--      grid-stressed state (FL/TX/LA/NC/PR + coastal CA)
--   3. inferred_from_ad — first_touch_channel implies use-case (e.g. an ad
--      campaign tagged 'rv' shouldn't get hurricane copy)
--
-- The query is conservative: anything ambiguous stays 'unknown' so Sol can
-- ask once instead of guessing wrong. Re-running is safe (only updates rows
-- where use_case is currently 'unknown').
--
-- Adapt the keyword lists and ZIP regex to match your actual data.

with chat_signals as (
  select
    c.customer_id,
    bool_or(m.content ~* '(huracan|hurricane|tormenta|storm)') as says_hurricane,
    bool_or(m.content ~* '(apag[óo]n|blackout|sin (luz|electricidad)|grid down)') as says_blackout,
    bool_or(m.content ~* '(rv|motorhome|camping|boondock|overland|van life|caravana)') as says_rv,
    bool_or(m.content ~* '(off.?grid|fuera de la red|cabin|caba[ñn]a|tiny house|ahorr[oa]r (en )?(luz|electric))') as says_offgrid,
    bool_or(m.content ~* '(cuba|venezuela|familia en (cuba|venezuela)|env[íi]o a cuba|paqueteria)') as says_diaspora
  from messages m
  join conversations c on c.id = m.conversation_id
  where m.direction = 'inbound'
  group by c.customer_id
),
hurricane_states as (
  -- Phone area codes / ZIP prefixes for storm-belt + PSPS-prone states.
  -- Intentionally rough — refine once you have a real ZIP column.
  select
    cust.id as customer_id,
    cust.phone ~ '^\+1(305|786|954|561|321|407|813|941|239|772|352|904|850)' as is_florida,
    cust.phone ~ '^\+1(713|281|832|409|361|512|979|936|956)' as is_texas,
    cust.phone ~ '^\+1(225|337|504|985|318)' as is_louisiana,
    cust.phone ~ '^\+1(252|336|704|828|910|919|980|984)' as is_nc,
    cust.phone ~ '^\+1(787|939)' as is_pr
  from customers cust
)
update customers cust set
  use_case = coalesce(
    case
      when cs.says_hurricane then 'hurricane'
      when cs.says_blackout and (hs.is_florida or hs.is_texas or hs.is_louisiana or hs.is_nc or hs.is_pr) then 'hurricane'
      when cs.says_blackout then 'home_emergency'
      when cs.says_rv then 'rv'
      when cs.says_offgrid then 'off_grid'
      when cs.says_diaspora then 'cuba_diaspora'
      when hs.is_florida or hs.is_texas or hs.is_louisiana or hs.is_nc or hs.is_pr then 'hurricane'
      when cust.first_touch_channel = 'rv-ads' then 'rv'
      when cust.first_touch_channel = 'hurricane-prep-ads' then 'hurricane'
      when cust.first_touch_channel = 'off-grid-ads' then 'off_grid'
      when cust.language = 'es' then 'cuba_diaspora'
      else null
    end,
    'unknown'
  ),
  use_case_inferred_at = now(),
  use_case_source = case
    when cs.says_hurricane or cs.says_blackout or cs.says_rv or cs.says_offgrid or cs.says_diaspora then 'inferred_from_chat'
    when hs.is_florida or hs.is_texas or hs.is_louisiana or hs.is_nc or hs.is_pr then 'inferred_from_zip'
    when cust.first_touch_channel like '%-ads' then 'inferred_from_ad'
    else 'inferred_from_chat'
  end
from chat_signals cs
right join hurricane_states hs on hs.customer_id = cs.customer_id
where cust.id = coalesce(cs.customer_id, hs.customer_id)
  and (cust.use_case is null or cust.use_case = 'unknown');


-- ===========================================================================
-- USE-CASE SEGMENTS — the four audience pillars Oiikon serves
-- ===========================================================================
-- Mirrors oiikon.com's own positioning: hurricane backup, home emergency
-- power, RV / overlanding, off-grid / energy savings. Each is a marketing
-- segment that wants a DIFFERENT template angle and DIFFERENT seasonality.
-- The cuba_diaspora cultural overlay can be combined with any of the four
-- (e.g. an RV buyer in Hialeah who also sends to family in Cuba).
--
-- Segments below assume `customers.use_case` is populated from chat / form /
-- ad-source heuristics. See conversation-outcomes.sql for the column.

-- --- SEGMENT: hurricane prep — pre-season window ---------------------------
-- Use case: marketing template ~30 days before hurricane season ramps
-- (early May for FL/TX/LA, ahead of June 1). Pair with a utility-template
-- "named storm forming" send when an actual hurricane is forecast.
select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language
from customers cust
where cust.use_case = 'hurricane'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '30 days');

-- --- SEGMENT: home emergency power — recent regional outage --------------
-- Use case: a "be ready next time" nudge in the days after a state-level
-- outage. Caller filters by ZIP / state list; this query just returns the
-- audience for the 'home_emergency' tag with the standard guards applied.
select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language
from customers cust
where cust.use_case = 'home_emergency'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '14 days');

-- --- SEGMENT: RV / overlanding — pre-trip & seasonal ----------------------
-- Use case: spring-warm-up campaigns, holiday-weekend nudges, RV-show
-- coincidences. Skip in deep winter unless the brief is gear-deal driven.
select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language
from customers cust
where cust.use_case = 'rv'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '21 days');

-- --- SEGMENT: off-grid / energy-saving ------------------------------------
-- Use case: utility-bill reduction, cabin/tiny-house, year-round buyers.
-- Slowest-decay segment — they reactivate based on price changes, not
-- weather. Default cooldown is longer.
select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language
from customers cust
where cust.use_case = 'off_grid'
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '45 days');

-- --- SEGMENT: Cuba diaspora — diaspora cultural overlay -------------------
-- Use case: Spanish-language sends with the apagones / familia-en-Cuba
-- frame. Can intersect with any of the four use-cases above (an RV-buyer
-- in Hialeah is still a diaspora buyer for a Cuba-themed campaign).
select
  cust.id as customer_id,
  cust.phone,
  cust.first_name,
  cust.language,
  cust.use_case as primary_use_case
from customers cust
where (cust.use_case = 'cuba_diaspora' or cust.language = 'es')
  and cust.marketing_opt_in = true
  and cust.opted_out = false
  and (cust.do_not_message_until is null or cust.do_not_message_until < now())
  and (cust.last_campaign_sent_at is null
       or cust.last_campaign_sent_at < now() - interval '21 days');


-- ===========================================================================
-- AUDIT QUERY: how is each bucket distributed right now?
-- ===========================================================================
-- Sanity check before campaigns. If 80% of customers are in 'dormant', the
-- bucketing logic probably needs tightening.

select
  bucket,
  count(*) as customers,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from customer_intent_bucket
group by 1
order by 2 desc;
