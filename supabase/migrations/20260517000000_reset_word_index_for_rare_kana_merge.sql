-- Force a re-index of every story's word occurrences. The regroup pass's
-- rare-merge veto is now kana-aware: it refuses to merge a kuromoji-split span
-- into a JMdict entry only when the merged surface is kana-only AND JPDB ranks
-- it no better than the very-rare tier (or not at all). This fixes bugs baked
-- into already-indexed stories:
--   * 高《たか》さ was split into 高 + 左派 — JPDB has no entry for 高さ at all
--     (it folds 高さ into the adjective 高い), so the old unranked-only veto
--     blocked the correct 高さ merge, and the leftover さ|は then collapsed
--     into the rare word 左派 (さは, rank 62,243).
--   * any other kuromoji-split kana run that exact-matched a rare-but-ranked
--     JMdict word slipped past the old veto, which only fired on unranked.
-- Clear the per-story stamp and the algorithm-placed rows; the
-- WordIndexBackfill queue re-populates them. Manual override rows
-- (manual = TRUE) are preserved — index_story_words rebuilds around them.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences WHERE manual = FALSE;
