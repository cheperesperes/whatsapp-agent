-- ============================================================
-- Normalize conversations.phone_number to canonical E.164
-- Fixes duplicate rows where same person exists as both
-- "+15551234567" and "15551234567". After this migration, all
-- rows have a leading '+' and duplicates are merged by keeping
-- the most-recently-updated row and re-pointing messages.
-- ============================================================

BEGIN;

-- 1) Find duplicates (normalized phone appears more than once) and merge.
WITH normalized AS (
  SELECT id,
         phone_number,
         CASE
           WHEN phone_number ~ '^\+' THEN phone_number
           ELSE '+' || phone_number
         END AS canonical,
         updated_at
  FROM conversations
),
ranked AS (
  SELECT id,
         canonical,
         ROW_NUMBER() OVER (PARTITION BY canonical ORDER BY updated_at DESC NULLS LAST, id) AS rn
  FROM normalized
),
survivors AS (
  SELECT canonical, id AS survivor_id FROM ranked WHERE rn = 1
),
losers AS (
  SELECT n.id AS loser_id, s.survivor_id
  FROM ranked r
  JOIN normalized n ON n.id = r.id
  JOIN survivors s ON s.canonical = r.canonical
  WHERE r.rn > 1
)
UPDATE messages m
SET conversation_id = l.survivor_id
FROM losers l
WHERE m.conversation_id = l.loser_id;

-- 2) Delete the now-empty duplicate rows.
WITH normalized AS (
  SELECT id,
         CASE
           WHEN phone_number ~ '^\+' THEN phone_number
           ELSE '+' || phone_number
         END AS canonical,
         updated_at
  FROM conversations
),
ranked AS (
  SELECT id,
         canonical,
         ROW_NUMBER() OVER (PARTITION BY canonical ORDER BY updated_at DESC NULLS LAST, id) AS rn
  FROM normalized
)
DELETE FROM conversations WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3) Normalize remaining rows so every phone_number starts with '+'.
UPDATE conversations
SET phone_number = '+' || phone_number
WHERE phone_number !~ '^\+';

-- 4) Enforce uniqueness going forward.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_phone_number_key
  ON conversations (phone_number);

COMMIT;
