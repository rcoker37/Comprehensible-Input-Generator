-- Aggregates that power the vocab side of the header total score and the
-- per-story payout tag on Compositions. Both mirror the kanji-exposure
-- pattern (see user_underused_kanji + readingScoreDelta in lib/rarity.ts):
-- the per-headword counts are read_count-weighted (re-reads count
-- separately), but the per-story payout uses raw within-story occurrence
-- counts so the delta represents the gain from reading the story ONE more
-- time on top of whatever weighted history already exists.

-- Per-headword totals across the user's read stories. Mirrors
-- get_word_encounters but returns every headword in a single round-trip
-- so the client can compute total vocab score without fan-out.
CREATE OR REPLACE FUNCTION get_user_word_encounters()
RETURNS TABLE (
  headword TEXT,
  encounters BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.headword,
    COALESCE(SUM(s.read_count), 0)::BIGINT AS encounters
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
    AND s.read_count > 0
  GROUP BY swo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_user_word_encounters() TO authenticated;

-- Per-story per-headword raw occurrence counts (NOT read_count-weighted).
-- One row per (story_id, headword) with `occurrences` = number of indexed
-- spans of that headword in that story. Used by Compositions to compute
-- "score gain if read once more" for each card. Includes every complete
-- story the user owns regardless of read state, so unread stories also get
-- a payout tag.
CREATE OR REPLACE FUNCTION get_per_story_word_occurrences()
RETURNS TABLE (
  story_id BIGINT,
  headword TEXT,
  occurrences BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.story_id,
    swo.headword,
    COUNT(*)::BIGINT AS occurrences
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
  GROUP BY swo.story_id, swo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_per_story_word_occurrences() TO authenticated;
