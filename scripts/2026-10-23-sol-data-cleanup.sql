-- Sol data cleanup — 2026-10-23
-- NOT executed. Review, then run in the Supabase SQL editor (project "Oiikon.com")
-- after the fix/sol-2026-refresh PR is merged. Each block is independent.
-- Every row below was looked up by id on 2026-10-23 (read-only); nothing is pattern-matched.

begin;

-- 1) Knowledge base: deactivate entries that contradict policy or are out of date.
--    Soft-disable (is_active=false) — rows stay for audit; Sol stops seeing them on the next message.
update knowledge_base set is_active = false, updated_at = now()
where id in (
  -- Offer Zelle / bank transfer / Tropipay "on request" — owner: only oiikon.com checkout.
  'c708fa94-3d8c-429a-b5f7-5dedb200bcc1',  -- ¿Cómo puedo pagar?
  '91354a3c-8f5f-4b70-9410-33056257f778',  -- How can I pay?
  '608ef6fe-6376-4078-b670-982e203ce4eb',  -- ¿Cuáles son los métodos de pago disponibles?
  'fc8c8af1-9e3b-46aa-a7d3-e5b383bf619b',  -- ¿Qué métodos de pago aceptan para las compras?
  -- Hard-coded F3000 price $799 (catalog on 2026-10-23: $899).
  '7d0506ea-c283-45ab-988b-aaf9f58267a3',
  -- WELCOME5 coupon answers — WELCOME5 is inactive in discount_codes.
  '3e55dc9a-0eed-443d-a4b6-c88915c95300',  -- precio final con descuento E3800LFP
  '48f29028-ec22-47b0-a393-04d8005c304f',  -- ¿Qué cupones o descuentos tienen?
  -- "Free shipping to Miami and selected Florida areas" — policy is free to the lower 48.
  '4f2c2fb4-c2aa-4a17-b834-acc35fd1c9af',
  -- Giveaway entry that says it ends July 19, 2026 (expired).
  '2e13ffca-dae0-4662-bcef-0d0c68eb8d82'
);
-- KEEP: '06f5a50f-85fd-49ab-a9d8-5c94312a5a83' (checkout-only payment answer — it mentions Zelle only to say "never").

-- 2) Coaching: retire the auto-learned rule that tells Sol to show a struck-through base price
--    (owner: final price only). The PR also filters it at load time; this makes it explicit.
update sol_learnings set status = 'retired', updated_at = now()
where id = '0e1a5263-0deb-4c40-98bb-c0feea2bec0f';

commit;

-- 3) OPTIONAL — test conversations polluting the dashboard (74 rows on 2026-10-23:
--    WhatsApp tests from 2026-04-13 and web sessions named claude/prod-/verify/diag/test-…).
--    Preview first:
select id, customer_name, channel, web_session_id, created_at
from conversations
where customer_name ~* '(^test|test$|tested|^jean test|^pierre test|^paulo test|^john test|budgetbuyer|urgentcustomer|clientecuba|testcustomer)'
   or (channel = 'web' and web_session_id ~* '^(claude|zero-c|prod-|final-|verify|diag|test-|previe|deploy|browse|reprot|corste|fullst|howto1|cachel|cachet|warmup|sorteo|cuba-d)')
order by created_at;
-- If the list is right, deleting also removes their messages (ON DELETE CASCADE). Irreversible:
-- delete from conversations where id in (<paste the ids you approved>);
