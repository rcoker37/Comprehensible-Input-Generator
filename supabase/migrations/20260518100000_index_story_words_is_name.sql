-- Thread `is_name` through the algorithm indexer. The word indexer can now
-- auto-detect a proper noun: when a multi-kanji ruby block is sub-segmented
-- (山手線《やまのてせん》 → 山手 / 線), a piece kuromoji tags 固有名詞 is
-- emitted with isName=true so the popover renders a "Name" header instead of
-- the unrelated common-noun JMdict entry (WORD_INDEX_VERSION 17).
--
-- Until now `index_story_words` always inserted is_name=FALSE — only
-- `set_story_word_overrides` (the manual override path) threaded the flag.
-- Recreate the function so it reads `isName` from each JSONB element, keeping
-- the existing non-manual-replace + manual-overlap-skip semantics intact.
--
-- Existing rows were indexed before the change, so clear the per-story stamp
-- and the algorithm-placed rows; the WordIndexBackfill queue re-populates them
-- (the WORD_INDEX_VERSION bump would re-index them anyway — this just makes it
-- immediate). Manual override rows (manual = TRUE) are preserved.

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
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_story_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_story_words(BIGINT, JSONB, INTEGER) TO authenticated;

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
