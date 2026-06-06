-- ─────────────────────────────────────────────────────────────────────────
-- Review tab: per-row cooldown + "Never forget" semantics.
--
-- The original schema used a single column (last_reviewed_at) and a
-- query-time cooldown_hours parameter on get_review_queue. The Review tab
-- now has two distinct advance actions with different cooldowns — Next
-- (24h, after revealing) and Never forget (permanent — the word never
-- appears in the queue again until the user manually clears it). Storing
-- eligibility per row means the queue RPC doesn't need to know about
-- different cooldown choices; it just compares eligible_at against now().
--
-- 'infinity'::TIMESTAMPTZ is the never-forget sentinel — PostgreSQL
-- supports it natively, and `eligible_at <= now()` is naturally false
-- for it, so those rows stay out of the queue without special casing.
--
-- A new Mastered tab lists every never-forget word so the user can
-- unmark them (get_mastered_words + clear_word_review).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE word_reviews
  ADD COLUMN eligible_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing rows were stamped with the old 24h-only semantics — backfill
-- so the upgrade doesn't yank any cooldown'd word back into the queue.
UPDATE word_reviews
SET eligible_at = last_reviewed_at + interval '24 hours';

-- record_word_review now accepts the per-row cooldown. NULL means
-- "never eligible again" (the Never forget button).
DROP FUNCTION IF EXISTS record_word_review(TEXT);

CREATE OR REPLACE FUNCTION record_word_review(
  p_headword TEXT,
  p_cooldown_hours INT DEFAULT 24
)
RETURNS VOID
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO word_reviews (user_id, headword, last_reviewed_at, eligible_at)
  VALUES (
    auth.uid(),
    p_headword,
    now(),
    CASE
      WHEN p_cooldown_hours IS NULL THEN 'infinity'::TIMESTAMPTZ
      ELSE now() + (p_cooldown_hours || ' hours')::INTERVAL
    END
  )
  ON CONFLICT (user_id, headword)
  DO UPDATE SET
    last_reviewed_at = now(),
    eligible_at = CASE
      WHEN p_cooldown_hours IS NULL THEN 'infinity'::TIMESTAMPTZ
      ELSE now() + (p_cooldown_hours || ' hours')::INTERVAL
    END;
$$;

GRANT EXECUTE ON FUNCTION record_word_review(TEXT, INT) TO authenticated;

-- get_review_queue drops its parameter — cooldown is now per-row, so
-- the filter is just eligible_at <= now(). The query no longer sorts —
-- the client sorts by JPDB rank (which Postgres doesn't know about).
DROP FUNCTION IF EXISTS get_review_queue(INT);

CREATE OR REPLACE FUNCTION get_review_queue()
RETURNS TABLE (
  headword TEXT,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH occ AS (
    SELECT swo.headword, 1::NUMERIC AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT swo.headword, 1::NUMERIC AS contribution, cm.last_read_at
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.read_count > 0
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
  ),
  totals AS (
    SELECT
      headword,
      SUM(contribution) AS encounters,
      MAX(last_read_at) AS last_read_at
    FROM occ
    GROUP BY headword
    HAVING SUM(contribution) = 1
  )
  SELECT t.headword, t.last_read_at
  FROM totals t
  LEFT JOIN word_reviews wr
    ON wr.user_id = auth.uid() AND wr.headword = t.headword
  WHERE wr.eligible_at IS NULL OR wr.eligible_at <= now();
$$;

GRANT EXECUTE ON FUNCTION get_review_queue() TO authenticated;

-- Lists every word the user has marked "Never forget". Powers the new
-- Mastered tab where the user can unmark words and bring them back into
-- the review queue.
CREATE OR REPLACE FUNCTION get_mastered_words()
RETURNS TABLE (
  headword TEXT,
  marked_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT headword, last_reviewed_at AS marked_at
  FROM word_reviews
  WHERE user_id = auth.uid()
    AND eligible_at = 'infinity'::TIMESTAMPTZ
  ORDER BY last_reviewed_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_mastered_words() TO authenticated;

-- Drops the review log entry for a headword, clearing both any cooldown
-- and the never-forget mark. Used by the Mastered tab's Unmark button —
-- the word is immediately eligible for the next review pass.
CREATE OR REPLACE FUNCTION clear_word_review(p_headword TEXT)
RETURNS VOID
LANGUAGE sql SECURITY INVOKER AS $$
  DELETE FROM word_reviews
  WHERE user_id = auth.uid() AND headword = p_headword;
$$;

GRANT EXECUTE ON FUNCTION clear_word_review(TEXT) TO authenticated;
