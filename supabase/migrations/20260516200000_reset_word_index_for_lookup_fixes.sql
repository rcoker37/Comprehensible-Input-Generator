-- Force a re-index of every story's word occurrences. Two lookup-pipeline
-- fixes change how spans canonicalise:
--
--   * lookupAtBoundary now arbitrates a pure-kana surface's exact match
--     against its best deinflection by JPDB frequency (exactRankWins in
--     lookupAtCursor.ts): the common 乗せる is kept for 「のせる」 instead of
--     the rare potential-form lemma 伸す.
--   * the regroup pass refuses a merge the LLM furigana contradict
--     (annotationContradictsHit), so 今日《きょう》は no longer collapses into
--     the greeting こんにちは.
--
-- Existing story_word_occurrences rows were populated before both fixes, so
-- clear the per-story stamp and the algorithm-placed rows; the
-- WordIndexBackfill queue re-populates them on next session.
--
-- Manual override rows (manual = TRUE) are preserved — index_story_words
-- rebuilds the algorithm rows around them.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
