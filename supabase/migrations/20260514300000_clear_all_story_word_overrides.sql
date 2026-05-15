-- "Reset overrides" affordance: a one-shot clear of every manual row for
-- a story. The per-region clear_story_word_overrides RPC handles surgical
-- removal, but the UI also needs an "I changed my mind about all of my
-- overrides on this story" path so the user doesn't have to walk through
-- each manually-edited region. Like the per-region clear, this nulls
-- word_index_at so the backfill re-runs and re-fills any spans the
-- manual rows had been shadowing.

CREATE OR REPLACE FUNCTION clear_all_story_word_overrides(
  p_story_id BIGINT
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
  WHERE story_id = p_story_id AND manual;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_all_story_word_overrides(BIGINT) TO authenticated;
