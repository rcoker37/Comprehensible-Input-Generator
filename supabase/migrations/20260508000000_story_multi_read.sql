-- Multi-read tracking: each re-read of a story counts toward kanji exposure.
--
-- read_at (single nullable timestamp) becomes a triple:
--   read_count    — total times marked read
--   first_read_at — set when the count first goes 0 → 1, never overwritten
--   last_read_at  — refreshed on every increment (replaces the old read_at)
--
-- mark_story_read() increments; undo_story_read() decrements with a floor of 0
-- and clears first/last when the count returns to 0. Server-side undo is a
-- safety net — the UI tracks per-session increments and only exposes the undo
-- affordance for those, so re-reads from past sessions can't be decremented.

ALTER TABLE stories ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stories ADD COLUMN first_read_at TIMESTAMPTZ;
ALTER TABLE stories RENAME COLUMN read_at TO last_read_at;

UPDATE stories
SET read_count = 1, first_read_at = last_read_at
WHERE last_read_at IS NOT NULL;

DROP INDEX IF EXISTS idx_stories_user_read;
CREATE INDEX idx_stories_user_read ON stories(user_id, last_read_at) WHERE read_count > 0;

CREATE OR REPLACE FUNCTION mark_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE stories
  SET read_count = stories.read_count + 1,
      first_read_at = COALESCE(stories.first_read_at, now()),
      last_read_at = now()
  WHERE id = p_story_id AND user_id = auth.uid()
  RETURNING stories.read_count, stories.first_read_at, stories.last_read_at;
$$;

CREATE OR REPLACE FUNCTION undo_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE stories
  SET read_count = GREATEST(stories.read_count - 1, 0),
      first_read_at = CASE WHEN stories.read_count <= 1 THEN NULL ELSE stories.first_read_at END,
      last_read_at = CASE WHEN stories.read_count <= 1 THEN NULL ELSE stories.last_read_at END
  WHERE id = p_story_id AND user_id = auth.uid()
  RETURNING stories.read_count, stories.first_read_at, stories.last_read_at;
$$;

GRANT EXECUTE ON FUNCTION mark_story_read(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION undo_story_read(BIGINT) TO authenticated;

-- Re-reads now contribute to exposure: each story's char counts are weighted
-- by read_count. Tie-breaking matches 20260428000000.
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
  SELECT uk.character, COALESCE(c.n, 0) AS exposures
  FROM user_kanji uk
  JOIN kanji k ON k.character = uk.character
  LEFT JOIN counts c ON c.ch = uk.character
  WHERE uk.user_id = auth.uid() AND uk.known = true
  ORDER BY COALESCE(c.n, 0) ASC, k.grade DESC, uk.character
  LIMIT p_limit;
$$;
