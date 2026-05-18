-- Force a re-index of every story's word occurrences. The regroup pass's
-- rare-merge veto now also covers JMdict `exp` *expression* entries — the
-- multi-word noun + particle + verb phrases JMdict lists as one idiom. A
-- kuromoji-split run is no longer merged into such an entry, exact or
-- deinflected, when JPDB has never ranked the phrase as a word:
--   * 雨が降り stays 雨 / が / 降り instead of collapsing into 雨が降る.
--   * 家を出て stays 家 / を / 出て instead of collapsing into 家を出る.
-- JPDB-ranked expressions common enough to be words in their own right
-- (青くなる, 木の葉) still merge. The previous veto skipped this case because
-- it never touched a kanji-bearing surface.
--
-- Existing story_word_occurrences rows were built before the fix and still
-- carry the merged expression spans, so clear the per-story stamp and the
-- algorithm-placed rows; the WordIndexBackfill queue re-populates them.
-- Manual override rows (manual = TRUE) are preserved — index_story_words
-- rebuilds the algorithm rows around them.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
