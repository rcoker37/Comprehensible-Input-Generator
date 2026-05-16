-- Add a last-read timestamp to the two browse-stats aggregates so the Stats
-- Browse section can sort kanji / vocab by "last read". Each row's
-- last_read_at is the MAX(stories.last_read_at) over the read stories that
-- contributed to the kanji's exposure / headword's encounter count. Every
-- contributing story has read_count > 0, so its last_read_at is always set
-- and the MAX is non-null for every returned row.
--
-- Both functions change their return signature, so each must be dropped
-- before recreation (CREATE OR REPLACE cannot alter the return type), which
-- also drops the grant — re-granted below.

DROP FUNCTION IF EXISTS user_underused_kanji(INT);

CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures BIGINT, last_read_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH read_text AS (
    SELECT strip_ruby(content) AS t, read_count, last_read_at
    FROM stories
    WHERE user_id = auth.uid() AND read_count > 0
  ),
  chars AS (
    SELECT (regexp_matches(t, '[一-龯㐀-䶿]', 'g'))[1] AS ch, read_count, last_read_at
    FROM read_text
  ),
  counts AS (
    SELECT ch, SUM(read_count)::BIGINT AS n, MAX(last_read_at) AS last_read_at
    FROM chars
    GROUP BY ch
  )
  SELECT k.character, c.n AS exposures, c.last_read_at
  FROM counts c
  JOIN kanji k ON k.character = c.ch
  ORDER BY c.n ASC, k.grade DESC, k.character
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION user_underused_kanji(INT) TO authenticated;

DROP FUNCTION IF EXISTS get_user_word_encounters();

CREATE OR REPLACE FUNCTION get_user_word_encounters()
RETURNS TABLE (
  headword TEXT,
  encounters BIGINT,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.headword,
    COALESCE(SUM(s.read_count), 0)::BIGINT AS encounters,
    MAX(s.last_read_at) AS last_read_at
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
    AND s.read_count > 0
  GROUP BY swo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_user_word_encounters() TO authenticated;
