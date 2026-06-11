-- Bug-hunt fix (2026-06-11): make the WhatsApp pay-link order insert atomic.
-- recordPayLinkOrder (lib/paylink.ts) runs from BOTH the PayPal return path and
-- the webhook, which fire near-simultaneously. Its idempotency was a non-atomic
-- SELECT-then-INSERT with no unique constraint, so one payment could create two
-- order rows → double fulfillment + double stock decrement.
--
-- This partial unique index (NULLs allowed, so storefront/non-paylink orders are
-- unaffected) makes the insert atomic. The app now upserts with
-- onConflict:'paypal_order_id', ignoreDuplicates:true.
-- Verified zero existing duplicates before creating. Applied to prod 2026-06-11.

create unique index if not exists orders_paypal_order_id_uidx
  on public.orders (paypal_order_id)
  where paypal_order_id is not null;
