-- Fix: 20260525000100 replaced the single UNIQUE constraint on
-- `story_word_occurrences (story_id, start_offset, end_offset)` with a
-- partial UNIQUE index (`WHERE story_id IS NOT NULL`) — but
-- `index_story_words` and `set_story_word_overrides` still referenced the
-- old unqualified `ON CONFLICT (story_id, start_offset, end_offset)`,
-- which Postgres can't match against a partial index. Every insert errored
-- with 42P10, no stamp was written, and the backfill kept re-picking
-- every story on every page load.
--
-- Re-create both functions with the predicate added so the partial index
-- is the inference target. Behaviour is otherwise unchanged.

DROP FUNCTION IF EXISTS index_story_words(BIGINT, JSONB, INTEGER);

CREATE OR REPLACE FUNCTION index_story_words(
  p_story_id BIGINT,
  p_occurrences JSONB,
  p_version INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stories WHERE id = p_story_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Story not found';
  END IF;

  DELETE FROM story_word_occurrences
  WHERE story_id = p_story_id AND NOT manual;

  INSERT INTO story_word_occurrences (
    user_id, story_id, start_offset, end_offset, surface, headword, reading, entry_id, manual, is_name
  )
  SELECT
    v_uid,
    p_story_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', ''),
    NULLIF(occ->>'entryId', '')::INT,
    FALSE,
    COALESCE((occ->>'isName')::BOOLEAN, FALSE)
  FROM jsonb_array_elements(p_occurrences) AS occ
  WHERE NOT EXISTS (
    SELECT 1
    FROM story_word_occurrences m
    WHERE m.story_id = p_story_id
      AND m.manual
      AND m.start_offset < (occ->>'end')::INT
      AND m.end_offset > (occ->>'start')::INT
  )
  ON CONFLICT (story_id, start_offset, end_offset)
    WHERE story_id IS NOT NULL
  DO NOTHING;

  UPDATE stories
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_story_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_story_words(BIGINT, JSONB, INTEGER) TO authenticated;


CREATE OR REPLACE FUNCTION set_story_word_overrides(
  p_story_id BIGINT,
  p_region_start INT,
  p_region_end INT,
  p_overrides JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stories WHERE id = p_story_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Story not found';
  END IF;

  IF p_region_end <= p_region_start THEN
    RAISE EXCEPTION 'Invalid region';
  END IF;

  DELETE FROM story_word_occurrences
  WHERE story_id = p_story_id
    AND start_offset < p_region_end
    AND end_offset > p_region_start;

  INSERT INTO story_word_occurrences (
    user_id, story_id, start_offset, end_offset, surface, headword, reading, entry_id, manual, is_name
  )
  SELECT
    v_uid,
    p_story_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', ''),
    NULLIF(occ->>'entryId', '')::INT,
    TRUE,
    COALESCE((occ->>'isName')::BOOLEAN, FALSE)
  FROM jsonb_array_elements(p_overrides) AS occ
  ON CONFLICT (story_id, start_offset, end_offset)
    WHERE story_id IS NOT NULL
  DO NOTHING;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_story_word_overrides(BIGINT, INT, INT, JSONB) TO authenticated;
