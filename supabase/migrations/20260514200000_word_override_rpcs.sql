-- RPCs that drive the manual-override UI:
--
-- set_story_word_overrides(story, region_start, region_end, overrides)
--   Region-replacement write. Deletes every row (manual or not) whose
--   span intersects [region_start, region_end), then inserts the
--   supplied overrides with manual=TRUE. Nulls word_index_at so the
--   backfill re-runs and re-fills any algorithm rows that lost their
--   match because they straddled the region boundary.
--
-- clear_story_word_overrides(story, region_start, region_end)
--   Deletes only the manual rows intersecting the region and nulls
--   word_index_at so the algorithm re-fills the gap.
--
-- update_story_content(story, content)
--   Replaces story content. Every offset-keyed artifact for the story
--   is wiped (translations, word_lookups, story_word_occurrences —
--   manual rows included, since their offsets are now meaningless) and
--   word_index_at + word_index_version are nulled. The backfill
--   re-indexes the story on the next pass.

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
    TRUE
  FROM jsonb_array_elements(p_overrides) AS occ
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_story_word_overrides(BIGINT, INT, INT, JSONB) TO authenticated;


CREATE OR REPLACE FUNCTION clear_story_word_overrides(
  p_story_id BIGINT,
  p_region_start INT,
  p_region_end INT
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

  DELETE FROM story_word_occurrences
  WHERE story_id = p_story_id
    AND manual
    AND start_offset < p_region_end
    AND end_offset > p_region_start;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_story_word_overrides(BIGINT, INT, INT) TO authenticated;


CREATE OR REPLACE FUNCTION update_story_content(
  p_story_id BIGINT,
  p_content TEXT
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

  UPDATE stories
  SET content = p_content,
      translations = '{}'::jsonb,
      word_index_at = NULL,
      word_index_version = NULL
  WHERE id = p_story_id;

  DELETE FROM word_lookups
  WHERE story_id = p_story_id AND user_id = v_uid;

  DELETE FROM story_word_occurrences
  WHERE story_id = p_story_id AND user_id = v_uid;
END;
$$;

GRANT EXECUTE ON FUNCTION update_story_content(BIGINT, TEXT) TO authenticated;
