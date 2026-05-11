-- Per-story word-index version. The client carries a `WORD_INDEX_VERSION`
-- constant in `lib/storyWordIndex.ts`; when the pipeline's deinflection or
-- regrouping rules change, that constant is bumped and every row with a
-- lower (or NULL) stamped version is treated as "needs re-index" by the
-- backfill context — replacing the one-off `UPDATE stories SET
-- word_index_at = NULL` migrations we previously shipped each time the
-- rules moved.
--
-- Existing rows get NULL on this column. The client's "needs index"
-- predicate treats NULL as out-of-date relative to any current version,
-- so a single deploy of the new constant kicks off the re-index for all
-- previously-indexed stories.

ALTER TABLE stories ADD COLUMN word_index_version INTEGER;

-- Re-create index_story_words to also stamp the caller-supplied version
-- so subsequent runs can compare. Old signature is dropped — clients ship
-- in lockstep with this migration.
DROP FUNCTION IF EXISTS index_story_words(BIGINT, JSONB);

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

  DELETE FROM story_word_occurrences WHERE story_id = p_story_id;

  INSERT INTO story_word_occurrences (
    user_id, story_id, start_offset, end_offset, surface, headword, reading
  )
  SELECT
    v_uid,
    p_story_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', '')
  FROM jsonb_array_elements(p_occurrences) AS occ
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_story_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_story_words(BIGINT, JSONB, INTEGER) TO authenticated;
