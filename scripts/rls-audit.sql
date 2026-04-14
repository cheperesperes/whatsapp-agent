-- ============================================================
-- Sol RLS audit
-- Run in Supabase SQL editor.  Every Sol-touching table must
-- have rowsecurity = true and every public policy must require
-- an authenticated user (NOT `true`, NOT `anon`).
-- ============================================================

-- 1) RLS flags
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'conversations',
    'messages',
    'handoffs',
    'agent_product_catalog',
    'knowledge_base'
  )
ORDER BY tablename;

-- 2) Policies — any row returned here that uses {public} or {anon}
--    with a permissive `true` qualifier is a leak.
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'conversations',
    'messages',
    'handoffs',
    'agent_product_catalog',
    'knowledge_base'
  )
ORDER BY tablename, policyname;
