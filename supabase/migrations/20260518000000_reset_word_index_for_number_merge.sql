-- Force a re-index of every story's word occurrences. Numbered words are now
-- handled by regroupNumberSpans (WORD_INDEX_VERSION 13). JMdict has whole-span
-- entries for a few common number+counter combos (五月, 二十二日) but not the
-- long tail — 一九二五年, 十四年, 二年前 were previously left unindexed (a dead
-- tap target) or split into meaningless per-digit spans. A numeral-led run is
-- now kept as one merged span when JPDB ranks the combo, and otherwise split
-- into the numeral run plus its counter (年, 前, …) as separate spans.
--
-- Existing story_word_occurrences rows were built before the change, so clear
-- the per-story stamp and the algorithm-placed rows; the WordIndexBackfill
-- queue re-populates them. Manual override rows (manual = TRUE) are preserved
-- — index_story_words rebuilds the algorithm rows around them.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
