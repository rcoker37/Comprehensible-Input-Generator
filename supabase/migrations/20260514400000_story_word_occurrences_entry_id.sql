-- Per-occurrence JMdict entry id. The indexer's `lookupAtBoundary`
-- already picks a single `WordResult` for each span (POS-filtered when
-- a kuromoji verb hint is in play, narrowed by deinflection rule
-- otherwise) — but until now we only stored its hiragana lemma. When
-- the popover later re-looked up that lemma to render the header, it
-- did so with no POS hint and `headwordFromHit` picked `results[0]` from
-- the raw JMdict ordering, which surfaces the wrong entry for any
-- homophone group: いきます → 幾 instead of 行く, ふっても → フル
-- instead of 降る, and so on.
--
-- Storing the entry id (nullable for backfill compatibility with legacy
-- rows) lets the popover hoist the indexer's chosen `WordResult` to
-- position 0 at display time, so the header always shows the entry the
-- index actually points at. Manual overrides land via
-- `set_story_word_overrides` and carry the entry id picked in the
-- override editor's candidate list.
--
-- `WORD_INDEX_VERSION` is bumped (client-side) so existing rows
-- re-index and pick up entry ids on the next backfill pass.

ALTER TABLE story_word_occurrences
  ADD COLUMN entry_id INTEGER;

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
    user_id, story_id, start_offset, end_offset, surface, headword, reading, entry_id, manual
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
    user_id, story_id, start_offset, end_offset, surface, headword, reading, entry_id, manual
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
    TRUE
  FROM jsonb_array_elements(p_overrides) AS occ
  ON CONFLICT (story_id, start_offset, end_offset) DO NOTHING;

  UPDATE stories
  SET word_index_at = NULL
  WHERE id = p_story_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_story_word_overrides(BIGINT, INT, INT, JSONB) TO authenticated;
