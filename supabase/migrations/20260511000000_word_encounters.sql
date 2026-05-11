-- Word-encounter counts for the caller. Mirrors the kanji-exposure pattern
-- (user_underused_kanji.exposures): aggregate per-headword occurrence rows
-- across the user's read stories, weighted by stories.read_count so
-- re-reads count separately. Powers the "53 encounters" tag in the word
-- popover and the new-word accent underline in StoryDisplay.

-- Per-headword total. Used by the popover for the active card.
CREATE OR REPLACE FUNCTION get_word_encounters(p_headword TEXT)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(SUM(s.read_count), 0)::BIGINT
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
    AND s.read_count > 0
    AND swo.headword = p_headword;
$$;

GRANT EXECUTE ON FUNCTION get_word_encounters(TEXT) TO authenticated;

-- Per-occurrence for a single story. Used by StoryDisplay so it can mark
-- spans whose headword has zero encounters across the user's history as
-- "new". Returns one row per indexed occurrence in the story; spans not
-- indexed yet are absent (no underline until the backfill catches up).
CREATE OR REPLACE FUNCTION get_story_word_encounters(p_story_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_story_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND story_id = p_story_id
  ),
  per_headword AS (
    SELECT swo.headword, COALESCE(SUM(s.read_count), 0)::BIGINT AS encounters
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND s.status = 'complete'
      AND s.read_count > 0
      AND swo.headword IN (SELECT headword FROM this_story_occ)
    GROUP BY swo.headword
  )
  SELECT
    tso.start_offset,
    tso.end_offset,
    COALESCE(ph.encounters, 0) AS encounters
  FROM this_story_occ tso
  LEFT JOIN per_headword ph ON ph.headword = tso.headword;
$$;

GRANT EXECUTE ON FUNCTION get_story_word_encounters(BIGINT) TO authenticated;
