-- Paragraph count is now fixed at 3 — the generator no longer offers a
-- choice. Remove every pre-existing story generated with a different
-- paragraph count so the library is uniform. Deleting the `stories` rows
-- cascades to `story_word_occurrences` and `word_lookups` (both FKs are
-- ON DELETE CASCADE).
--
-- The `stories.paragraphs` column itself is kept: it is NOT NULL and the
-- generate-story Edge Function still writes a constant 3 into it. It is no
-- longer read or surfaced anywhere in the UI.

DELETE FROM stories WHERE paragraphs <> 3;
