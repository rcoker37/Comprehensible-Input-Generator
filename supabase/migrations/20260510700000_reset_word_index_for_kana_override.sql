-- Force a re-index of every story's word occurrences. The lookup pipeline
-- now demotes kanji-canonical kana matches in favour of substantive
-- deinflections (see isKanjiCanonicalKanaMatch in lookupAtCursor.ts), which
-- means spans previously canonicalised to entries like 生き体 (matched on
-- reading いきたい) now resolve to いく via the -たい rule. Existing rows in
-- story_word_occurrences carry the old headwords, so clear them and let the
-- backfill re-populate.

UPDATE stories SET word_index_at = NULL WHERE word_index_at IS NOT NULL;
DELETE FROM story_word_occurrences;
