-- ─────────────────────────────────────────────────────────────────────────
-- Review tab: vocab "review" log + 24h cooldown queue.
--
-- The Review tab surfaces words encountered exactly once across the user's
-- read stories + read assistant chat messages, oldest exposure first. When
-- the user advances past a card we stamp word_reviews so the same word
-- can't reappear in the queue until the cooldown window has passed; after
-- it expires the word slots back in at its natural sort position (driven
-- by the original last_read_at, not the review time — review tracks
-- cooldown, not exposure).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE word_reviews (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  headword TEXT NOT NULL,
  last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, headword)
);

ALTER TABLE word_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own reviews" ON word_reviews
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Upsert the current user's review timestamp for the headword. Called from
-- the Review tab when the user hits "Next" to advance past a card. The
-- conflict path refreshes the timestamp so the cooldown window slides
-- forward each time the word is re-reviewed.
CREATE OR REPLACE FUNCTION record_word_review(p_headword TEXT)
RETURNS VOID
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO word_reviews (user_id, headword, last_reviewed_at)
  VALUES (auth.uid(), p_headword, now())
  ON CONFLICT (user_id, headword)
  DO UPDATE SET last_reviewed_at = now();
$$;

GRANT EXECUTE ON FUNCTION record_word_review(TEXT) TO authenticated;

-- Review queue: headwords the user has encountered exactly once across all
-- read sources, excluding any reviewed within the cooldown window. Ordered
-- by last_read_at ASC so the oldest exposure is first in the queue.
--
-- Mirrors the UNION-ALL shape of get_user_word_encounters so the encounter
-- count is consistent: each occurrence row contributes a flat 1, both
-- arms filter to complete + read sources.
CREATE OR REPLACE FUNCTION get_review_queue(p_cooldown_hours INT DEFAULT 24)
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
  WHERE wr.last_reviewed_at IS NULL
     OR wr.last_reviewed_at < now() - (p_cooldown_hours || ' hours')::INTERVAL
  ORDER BY t.last_read_at ASC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION get_review_queue(INT) TO authenticated;
