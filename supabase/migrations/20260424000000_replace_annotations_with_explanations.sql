-- Drop the per-story full annotation payload (tokens, glosses, sentence
-- boundaries) in favor of a lightweight explanations cache keyed by the
-- char-offset span the learner tapped.
--
-- `explanations` JSONB shape:
--   {
--     "<start_offset>-<end_offset>": { text: string, generated_at: string }
--   }
--
-- The tap-to-lookup UI now resolves words at cursor time against JMdict on
-- the client, so there is no pre-computed annotation payload to persist.

ALTER TABLE stories DROP COLUMN annotations;
ALTER TABLE stories ADD COLUMN explanations JSONB;
