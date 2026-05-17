-- Force a re-index of every story's word occurrences. The regroup pass now
-- refuses to merge a kuromoji-split span into a JMdict entry JPDB has never
-- ranked as a word — particle / expression runs like では and これは, which
-- kuromoji already splits correctly (で|は, これ|は). Existing
-- story_word_occurrences rows were built before the fix and still carry the
-- merged では / これは spans, so clear the per-story stamp and the
-- algorithm-placed rows; the WordIndexBackfill queue re-populates them.
--
-- Manual override rows (manual = TRUE) are preserved — index_story_words
-- rebuilds the algorithm rows around them.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
