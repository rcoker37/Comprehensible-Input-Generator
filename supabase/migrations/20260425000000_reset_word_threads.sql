-- Evolve `stories.explanations` from a single explanation per word span into a
-- per-word conversation thread. The new shape is incompatible with the old; the
-- previous payload was a small cache and is safe to discard.
--
-- New `explanations` JSONB shape (keyed by `<start_offset>-<end_offset>`):
--   {
--     "<start>-<end>": {
--       "version": 1,
--       "messages": [
--         { "role": "overview" | "user" | "assistant",
--           "content": string,
--           "generated_at": string }
--         ...
--       ]
--     }
--   }
-- Invariant: if any element has role="overview", it is messages[0].

UPDATE stories SET explanations = '{}'::jsonb WHERE explanations IS NOT NULL;
