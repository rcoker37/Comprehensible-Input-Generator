-- Per-user word lookup history. Records every popover open with a meaningful
-- dictionary match so the popover can render a carousel of "every place I've
-- looked up this word" — across all the user's stories.
--
-- Grouping is by `headword` (the deinflected JMdict lemma when the surface
-- inflects, the surface itself otherwise). Multiple lookups of the same span
-- in the same story collapse via UNIQUE upsert — `looked_up_at` is refreshed
-- and `lookup_count` is incremented.

CREATE TABLE word_lookups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  start_offset INT NOT NULL,
  end_offset INT NOT NULL,
  surface TEXT NOT NULL,
  headword TEXT NOT NULL,
  reading TEXT,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lookup_count INT NOT NULL DEFAULT 1,
  UNIQUE (user_id, story_id, start_offset, end_offset)
);

CREATE INDEX word_lookups_history_idx
  ON word_lookups (user_id, headword, looked_up_at DESC);

ALTER TABLE word_lookups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own word lookups"
  ON word_lookups FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Upsert a lookup for the calling user. Increments lookup_count and refreshes
-- looked_up_at on conflict; refreshes headword/reading/surface in case the
-- deinflection logic produced a different canonical form than the prior call.
CREATE OR REPLACE FUNCTION record_word_lookup(
  p_story_id BIGINT,
  p_start INT,
  p_end INT,
  p_surface TEXT,
  p_headword TEXT,
  p_reading TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO word_lookups (
    user_id, story_id, start_offset, end_offset, surface, headword, reading
  )
  VALUES (
    v_uid, p_story_id, p_start, p_end, p_surface, p_headword, p_reading
  )
  ON CONFLICT (user_id, story_id, start_offset, end_offset) DO UPDATE
  SET looked_up_at = now(),
      lookup_count = word_lookups.lookup_count + 1,
      headword = EXCLUDED.headword,
      reading = EXCLUDED.reading,
      surface = EXCLUDED.surface;
END;
$$;

GRANT EXECUTE ON FUNCTION record_word_lookup(BIGINT, INT, INT, TEXT, TEXT, TEXT) TO authenticated;

-- Returns every prior lookup of the given headword for the calling user,
-- joined with each lookup's story (title, content, created_at) and any
-- explanation threads stored at that span. Threads come from the story's
-- explanations JSONB at the key `${start}-${end}`. Most recent first.
CREATE OR REPLACE FUNCTION get_word_usages(p_headword TEXT)
RETURNS TABLE (
  lookup_id BIGINT,
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
    wl.id AS lookup_id,
    wl.story_id,
    s.title AS story_title,
    s.content AS story_content,
    s.created_at AS story_created_at,
    wl.start_offset,
    wl.end_offset,
    wl.surface,
    wl.reading,
    s.explanations -> (wl.start_offset::text || '-' || wl.end_offset::text) AS threads,
    wl.looked_up_at,
    wl.lookup_count
  FROM word_lookups wl
  JOIN stories s ON s.id = wl.story_id
  WHERE wl.user_id = auth.uid()
    AND wl.headword = p_headword
    AND s.status = 'complete'
  ORDER BY wl.looked_up_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;
