-- Drop the "known" kanji concept. Kanji are now classified purely by whether
-- the user has read a story containing them; everything else (header score,
-- per-story payouts, prompt-side stretch suggestions) is derived from
-- read-story exposure.
--
-- The user_kanji table itself is left in place — no consumer reads it
-- anymore, but dropping it can wait until we're sure nothing surprising
-- references it.
--
-- Two changes:
--   1. user_underused_kanji() returns under-exposed SEEN kanji (exposure > 0),
--      sourced from read stories instead of joined to user_kanji.known.
--   2. get_user_kanji() is removed — the client no longer needs an
--      every-kanji-with-known-flag dump.

DROP FUNCTION IF EXISTS get_user_kanji();

CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH read_text AS (
    SELECT strip_ruby(content) AS t, read_count
    FROM stories
    WHERE user_id = auth.uid() AND read_count > 0
  ),
  chars AS (
    SELECT (regexp_matches(t, '[一-龯㐀-䶿]', 'g'))[1] AS ch, read_count
    FROM read_text
  ),
  counts AS (
    SELECT ch, SUM(read_count)::BIGINT AS n
    FROM chars
    GROUP BY ch
  )
  SELECT k.character, c.n AS exposures
  FROM counts c
  JOIN kanji k ON k.character = c.ch
  ORDER BY c.n ASC, k.grade DESC, k.character
  LIMIT p_limit;
$$;
