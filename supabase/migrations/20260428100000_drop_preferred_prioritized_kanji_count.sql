-- The slider that wrote this preference has been replaced with per-kanji
-- toggle buttons in the Generator; selection is now per-session only,
-- not persisted, so the column is no longer needed.

ALTER TABLE profiles DROP COLUMN preferred_prioritized_kanji_count;
