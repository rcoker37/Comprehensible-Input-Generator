-- Per-story read tracking + on-demand kanji exposure aggregation.
--
-- read_at: NULL until the user clicks "Mark as Read"; toggleable.
-- user_underused_kanji(): for prompt injection — returns the user's known
-- kanji ordered by exposure count ASC, with random tie-breaking so repeated
-- generations don't always propose the same characters.

ALTER TABLE stories ADD COLUMN read_at TIMESTAMPTZ;

CREATE INDEX idx_stories_user_read ON stories(user_id, read_at) WHERE read_at IS NOT NULL;

-- Mirror of client stripAnnotations() at client/src/lib/furigana.ts:97-99
-- (regex /《[^《》]*》/g): drop Aozora ruby blocks before counting kanji.
CREATE OR REPLACE FUNCTION strip_ruby(t TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(t, '《[^《》]*》', '', 'g');
$$;

-- Top-N least-exposed *known* kanji from the caller's read stories.
-- Kanji range mirrors KANJI_REGEX_G in client/src/lib/constants.ts:
-- CJK Unified Ideographs (U+4E00-9FAF) plus CJK Extension A (U+3400-4DBF).
CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH read_text AS (
    SELECT strip_ruby(content) AS t
    FROM stories
    WHERE user_id = auth.uid() AND read_at IS NOT NULL
  ),
  chars AS (
    SELECT (regexp_matches(t, '[一-龯㐀-䶿]', 'g'))[1] AS ch
    FROM read_text
  ),
  counts AS (
    SELECT ch, COUNT(*)::BIGINT AS n
    FROM chars
    GROUP BY ch
  )
  SELECT uk.character, COALESCE(c.n, 0) AS exposures
  FROM user_kanji uk
  LEFT JOIN counts c ON c.ch = uk.character
  WHERE uk.user_id = auth.uid() AND uk.known = true
  ORDER BY COALESCE(c.n, 0) ASC, RANDOM()
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION user_underused_kanji(INT) TO authenticated;
