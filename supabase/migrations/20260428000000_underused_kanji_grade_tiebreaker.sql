-- Replace the random tiebreaker in user_underused_kanji with a deterministic
-- ordering: exposure ASC, then kanji.grade DESC (so secondary/grade-8 and
-- higher-grade kanji surface first within an exposure bucket — these are the
-- most recently learned kanji and the most useful to drill), then character
-- as a final deterministic tiebreaker.

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
  JOIN kanji k ON k.character = uk.character
  LEFT JOIN counts c ON c.ch = uk.character
  WHERE uk.user_id = auth.uid() AND uk.known = true
  ORDER BY COALESCE(c.n, 0) ASC, k.grade DESC, uk.character
  LIMIT p_limit;
$$;
