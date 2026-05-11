-- Force a re-index of every story's word occurrences. The deinflection
-- engine now ranks candidates by how much of the surface a rule consumed
-- (see japaneseDeinflect.ts), which fixes false positives like いきます being
-- canonicalised to いきむ instead of いく. Existing rows in
-- story_word_occurrences were populated under the old ranking and need to
-- be regenerated, so we clear the per-story stamp; the WordIndexBackfill
-- queue picks every read story back up on next session.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences;
