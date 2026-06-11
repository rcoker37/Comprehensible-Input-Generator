-- ─────────────────────────────────────────────────────────────────────────
-- 1. New content type: 'learn_word'.
--
-- A Learn Word generation explains a single vocabulary word the user has
-- encountered but not yet absorbed (client picks it from the top-50 most
-- frequent words with < 10 encounters). The target word is stored in the
-- existing `topic` column, so no new column is needed — only the CHECK
-- constraint widens.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE stories DROP CONSTRAINT stories_content_type_check;
ALTER TABLE stories ADD CONSTRAINT stories_content_type_check
  CHECK (content_type IN ('fiction', 'nonfiction', 'learn_word'));

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Review queue: widen from exactly-once to fewer-than-10 encounters.
--
-- The once-seen filter made the queue dry up as soon as a word was read a
-- second time, even though 2–9 encounters is still squarely "being
-- learned". The rare-kanji gate is unchanged, but a headword can now have
-- multiple occurrences with *different* surfaces (降る seen as 降る and
-- 降り), so the gate checks the kanji against the concatenation of every
-- distinct surface rather than the single MAX(surface) — kanji are single
-- characters, so concatenation can't manufacture a false positive.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_review_queue()
RETURNS TABLE (
  headword TEXT,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH occ AS (
    SELECT swo.headword, swo.surface, 1::NUMERIC AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT swo.headword, swo.surface, 1::NUMERIC AS contribution, cm.last_read_at
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.read_count > 0
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
  ),
  kanji_chars AS (
    SELECT (regexp_matches(strip_ruby(s.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
    FROM stories s
    WHERE s.user_id = auth.uid()
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT (regexp_matches(strip_ruby(cm.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
    FROM chat_messages cm
    WHERE cm.user_id = auth.uid()
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
      AND cm.read_count > 0
  ),
  rare_kanji AS (
    SELECT ch FROM kanji_chars GROUP BY ch HAVING COUNT(*) < 10
  ),
  totals AS (
    -- All distinct surfaces concatenated: the rare-kanji EXISTS below is a
    -- per-character containment check, so concatenation is a safe way to
    -- test "any surface of this headword carries a rare kanji".
    SELECT
      headword,
      string_agg(DISTINCT surface, '') AS surfaces,
      SUM(contribution) AS encounters,
      MAX(last_read_at) AS last_read_at
    FROM occ
    GROUP BY headword
    HAVING SUM(contribution) < 10
  )
  SELECT t.headword, t.last_read_at
  FROM totals t
  LEFT JOIN word_reviews wr
    ON wr.user_id = auth.uid() AND wr.headword = t.headword
  WHERE (wr.eligible_at IS NULL OR wr.eligible_at <= now())
    AND EXISTS (
      SELECT 1 FROM rare_kanji rk
      WHERE position(rk.ch IN t.surfaces) > 0
    );
$$;

GRANT EXECUTE ON FUNCTION get_review_queue() TO authenticated;
