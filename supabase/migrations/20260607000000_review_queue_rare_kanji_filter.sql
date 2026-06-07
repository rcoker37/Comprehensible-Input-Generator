-- ─────────────────────────────────────────────────────────────────────────
-- Review queue: narrow to once-seen vocab whose occurrence carries a
-- rarely-seen kanji.
--
-- The "all once-seen vocab" queue was too broad — a beginner who's read
-- a few stories gets hundreds of cards, most of them words built on
-- well-trodden kanji (人, 行, 食…) the user isn't actually struggling
-- with. The interesting cards are the ones that contain a kanji the user
-- has barely encountered, because that's where the next round of
-- exposure most reinforces a fragile glyph.
--
-- Filter: a candidate survives iff its (one) occurrence's surface
-- contains at least one kanji whose total exposure count — counted on
-- the same shape as user_underused_kanji, i.e. per-character occurrences
-- across read stories + read assistant chat messages — is < 10.
--
-- Kana-only words have no kanji and so are excluded.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_review_queue();

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
    -- For a HAVING SUM = 1 headword there is exactly one row in `occ`,
    -- so MAX(surface) returns THE surface of the only occurrence.
    SELECT
      headword,
      MAX(surface) AS surface,
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
  WHERE (wr.eligible_at IS NULL OR wr.eligible_at <= now())
    AND EXISTS (
      SELECT 1 FROM rare_kanji rk
      WHERE position(rk.ch IN t.surface) > 0
    );
$$;

GRANT EXECUTE ON FUNCTION get_review_queue() TO authenticated;
