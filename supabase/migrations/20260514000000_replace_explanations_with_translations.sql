-- Retire the per-word chip Q&A feature and replace it with a per-sentence
-- AI translation cache. The new shape is:
--
--   stories.translations JSONB
--     {
--       "<sentence_start>-<sentence_end>": {
--         "text":  "...English translation...",
--         "model": "anthropic/claude-sonnet-4.6",
--         "generated_at": "2026-05-13T..."
--       },
--       ...
--     }
--
-- Sentence offsets are character offsets in the cleaned content (same space
-- the word offsets use), computed by the client's extractSentenceSnippet so
-- both sides agree on sentence boundaries. The translate-sentence Edge
-- Function reads/writes this column.

ALTER TABLE stories DROP COLUMN IF EXISTS explanations;
ALTER TABLE stories ADD COLUMN translations JSONB;

COMMENT ON COLUMN stories.translations IS
  'Cache of AI sentence translations keyed by "<sentence_start>-<sentence_end>". Each value is { text, model, generated_at }.';

-- get_word_usages no longer returns threads (the chip Q&A column is gone).
-- The carousel's per-card data now consists of the sentence + an on-demand
-- translation fetched separately.
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
