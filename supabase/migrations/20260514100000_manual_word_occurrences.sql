-- Manual word-occurrence overrides: a `manual` boolean on
-- `story_word_occurrences` flags rows the user placed by hand via the
-- override UI. Manual rows survive `index_story_words` re-runs and
-- shadow any algorithm-generated span that overlaps them, so a single
-- bad regroup/disambiguation decision can be pinned without bumping
-- WORD_INDEX_VERSION for the whole library.
--
-- Wire-up:
--   * `index_story_words` deletes only non-manual rows for the story
--     before re-inserting algorithm-derived spans. Any algorithm span
--     whose half-open `[start, end)` overlaps a manual row is filtered
--     out at INSERT time — manual rows always win.
--   * `set_story_word_overrides` (next migration) handles the region-
--     replacement write that places manual rows.

ALTER TABLE story_word_occurrences
  ADD COLUMN manual BOOLEAN NOT NULL DEFAULT FALSE;

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
    user_id, story_id, start_offset, end_offset, surface, headword, reading, manual
  )
  SELECT
    v_uid,
    p_story_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', ''),
    FALSE
  FROM jsonb_array_elements(p_occurrences) AS occ
  WHERE NOT EXISTS (
    SELECT 1
    FROM story_word_occurrences m
    WHERE m.story_id = p_story_id
      AND m.manual
      AND m.start_offset < (occ->>'end')::INT
      AND m.end_offset > (occ->>'start')::INT
  )
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_story_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_story_words(BIGINT, JSONB, INTEGER) TO authenticated;
