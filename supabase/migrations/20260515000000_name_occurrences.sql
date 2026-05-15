-- Lightweight "treat this span as a name" flag on story_word_occurrences.
-- The override editor gains a "Match as name" toggle per sub-span; when
-- on, the row is stored with is_name=TRUE, the surface as its own
-- headword, entry_id=NULL, and a user-supplied reading. The popover sees
-- the flag and renders a "Name" header instead of running a JMdict
-- lookup that would only ever produce false matches (個人名 like 田中
-- aren't in JMdict at all, and bigram-overlapping names like 山田 would
-- otherwise look up 山 + 田 as words).
--
-- Algorithm rows are never names — `index_story_words` continues to
-- insert with the default (FALSE), so no signature change there. Only
-- `set_story_word_overrides` needs to thread is_name through from the
-- JSONB payload.

ALTER TABLE story_word_occurrences
  ADD COLUMN is_name BOOLEAN NOT NULL DEFAULT FALSE;

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
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_story_word_overrides(BIGINT, INT, INT, JSONB) TO authenticated;
