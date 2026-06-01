-- ─────────────────────────────────────────────────────────────────────────
-- Stories become single-read: a story is either read (read_count = 1) or
-- unread (read_count = 0). The Mark-as-Read button now toggles between
-- those two states with no cooldown, no cap, no diminishing-returns
-- weighting. Chats keep their multi-read behavior (mark_chat_read,
-- get_per_chat_payout, etc. are untouched).
--
-- Migration steps:
--   1. Cap existing legacy stories.read_count to 1 so old multi-read rows
--      collapse cleanly to the new model. first_read_at / last_read_at
--      stay as-is.
--   2. Replace mark_story_read with an idempotent "set to 1" that ignores
--      cooldown and cap. Calling it on an already-read story is a no-op
--      that still returns the current state.
--   3. undo_story_read keeps its existing decrement-with-floor-0 shape but
--      simplifies to a hard reset (read_count = 0, clear first/last_read_at).
--   4. user_underused_kanji loses its read_weight() multiplication —
--      stories are 0/1 now so every contributing read counts as 1.
--   5. get_per_story_word_occurrences switches to a binary delta: a story's
--      occurrences only contribute when read_count = 0 (the next mark would
--      flip it to read). Already-read stories contribute 0 to the payout.
--
-- Story-side encounter RPCs (get_word_encounters, get_user_word_encounters,
-- get_story_word_encounters, get_chat_message_word_encounters) keep
-- read_weight() — for rc=1 it returns 1.0, matching the raw count after the
-- cap UPDATE — so no functional change there.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE stories SET read_count = 1 WHERE read_count > 1;

CREATE OR REPLACE FUNCTION mark_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE stories
  SET read_count = 1,
      first_read_at = COALESCE(stories.first_read_at, now()),
      last_read_at = now()
  WHERE id = p_story_id
    AND user_id = auth.uid()
    AND stories.read_count = 0;

  RETURN QUERY
  SELECT s.read_count, s.first_read_at, s.last_read_at
  FROM stories s
  WHERE s.id = p_story_id AND s.user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION mark_story_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION undo_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE stories
  SET read_count = 0,
      first_read_at = NULL,
      last_read_at = NULL
  WHERE id = p_story_id AND user_id = auth.uid()
  RETURNING stories.read_count, stories.first_read_at, stories.last_read_at;
$$;

GRANT EXECUTE ON FUNCTION undo_story_read(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS user_underused_kanji(INT);

CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures NUMERIC, last_read_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH read_text AS (
    SELECT strip_ruby(content) AS t, last_read_at
    FROM stories
    WHERE user_id = auth.uid() AND read_count > 0
  ),
  chars AS (
    SELECT (regexp_matches(t, '[一-龯㐀-䶿]', 'g'))[1] AS ch, last_read_at
    FROM read_text
  ),
  counts AS (
    SELECT ch, COUNT(*)::NUMERIC AS n, MAX(last_read_at) AS last_read_at
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

DROP FUNCTION IF EXISTS get_per_story_word_occurrences();

CREATE OR REPLACE FUNCTION get_per_story_word_occurrences()
RETURNS TABLE (
  story_id BIGINT,
  headword TEXT,
  occurrences NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.story_id,
    swo.headword,
    COUNT(*)::NUMERIC AS occurrences
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
    AND s.read_count = 0
  GROUP BY swo.story_id, swo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_per_story_word_occurrences() TO authenticated;
