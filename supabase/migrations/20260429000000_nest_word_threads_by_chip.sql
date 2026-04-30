-- Nest existing per-range explanation threads under a "custom" sub-key so the
-- column can hold multiple threads per range (one per ask-chip plus custom).
--
-- Old shape: { "<start>-<end>": { version, messages: [...] } }
-- New shape: { "<start>-<end>": { "<thread_id>": { version, messages: [...] } } }
--
-- Old rows are detected by an inner value with a `messages` field (the
-- WordThread). Idempotent: re-running is a no-op once values are wrappers.

UPDATE stories
SET explanations = (
  SELECT jsonb_object_agg(key, jsonb_build_object('custom', value))
  FROM jsonb_each(explanations)
)
WHERE jsonb_typeof(explanations) = 'object'
  AND explanations <> '{}'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_each(explanations) AS e WHERE e.value ? 'messages'
  );

COMMENT ON COLUMN stories.explanations IS
  'Per-word per-thread chat history. Shape: { "<start>-<end>": { "<thread_id>": { version, messages: [{ role, content, generated_at }] } } }. thread_id is "custom" or a chip id from askChips.ts. For chip threads, messages[0] is the chip-prompt seed — hidden in the UI but sent to the model as a regular user turn.';
