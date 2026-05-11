-- get_word_usages used to be naturally limited to read stories because
-- the backfill only indexed read stories. Indexing now happens for every
-- complete story (so taps on a freshly-generated story don't have to wait
-- for the indexer to fire). The "only show me usages from stories I've
-- actually read" guarantee moves into this RPC.
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
    AND s.read_count > 0
  ORDER BY s.created_at DESC, swo.start_offset ASC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;
