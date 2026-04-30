-- Wipe all stored per-word chat threads. Suspected data corruption from
-- earlier rounds of the chips-only refactor; safer to start clean than to
-- chase a bug we can't pin down. The cache is rebuildable with a click.

UPDATE stories SET explanations = '{}'::jsonb WHERE explanations IS NOT NULL;
