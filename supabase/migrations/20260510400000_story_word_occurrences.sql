-- Story-wide word index: every regrouped tap span in a tokenized story,
-- keyed by headword so the popover carousel can surface every place the
-- user has encountered a word — not just spans they previously tapped.
--
-- Population is client-driven from StoryReadButton: when a user marks a
-- story read, the client runs the same regroup + JMdict pipeline that
-- powers StoryDisplay and bulk-uploads every (start, end, headword) span.
-- The story is stamped via `word_index_at` so we don't redo the work on
-- subsequent reads. A null stamp on a previously-read story (legacy data)
-- causes the indexer to fire again on the next mark-as-read.
--
-- get_word_usages is rewritten to source from this table (every
-- occurrence) and LEFT JOIN word_lookups for the optional tap-history
-- metadata (looked_up_at / lookup_count). Stories without an index yet
-- contribute nothing — they show up in the carousel only after their
-- first mark-as-read.

ALTER TABLE stories ADD COLUMN word_index_at TIMESTAMPTZ;

CREATE TABLE story_word_occurrences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  start_offset INT NOT NULL,
  end_offset INT NOT NULL,
  surface TEXT NOT NULL,
  headword TEXT NOT NULL,
  reading TEXT,
  UNIQUE (story_id, start_offset, end_offset)
);

CREATE INDEX story_word_occurrences_user_headword_idx
  ON story_word_occurrences (user_id, headword);

ALTER TABLE story_word_occurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own story word occurrences"
  ON story_word_occurrences FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Replace the whole index for a story in a single call. Deletes existing
-- rows first so a future tokenizer-rule change re-canonicalises everything
-- when the indexer is re-run. Stamps word_index_at on success.
CREATE OR REPLACE FUNCTION index_story_words(
  p_story_id BIGINT,
  p_occurrences JSONB
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
  SET word_index_at = v_now
  WHERE id = p_story_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_story_words(BIGINT, JSONB) TO authenticated;

-- Rewrite get_word_usages to source from story_word_occurrences. Every
-- occurrence of the headword across the user's tokenized stories shows up,
-- not just spans the user previously tapped. word_lookups is LEFT JOINed
-- so the carousel can still surface "you've tapped this N times" without
-- making it the gating signal.
DROP FUNCTION IF EXISTS get_word_usages(TEXT);
CREATE OR REPLACE FUNCTION get_word_usages(p_headword TEXT)
RETURNS TABLE (
  occurrence_id BIGINT,
  story_id BIGINT,
  story_title TEXT,
  story_content TEXT,
  story_created_at TIMESTAMPTZ,
  start_offset INT,
  end_offset INT,
  surface TEXT,
  reading TEXT,
  threads JSONB,
  looked_up_at TIMESTAMPTZ,
  lookup_count INT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.id AS occurrence_id,
    swo.story_id,
    s.title AS story_title,
    s.content AS story_content,
    s.created_at AS story_created_at,
    swo.start_offset,
    swo.end_offset,
    swo.surface,
    swo.reading,
    s.explanations -> (swo.start_offset::text || '-' || swo.end_offset::text) AS threads,
    wl.looked_up_at,
    COALESCE(wl.lookup_count, 0) AS lookup_count
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  LEFT JOIN word_lookups wl
    ON wl.user_id = swo.user_id
    AND wl.story_id = swo.story_id
    AND wl.start_offset = swo.start_offset
    AND wl.end_offset = swo.end_offset
  WHERE swo.user_id = auth.uid()
    AND swo.headword = p_headword
    AND s.status = 'complete'
  ORDER BY s.created_at DESC, swo.start_offset ASC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;
