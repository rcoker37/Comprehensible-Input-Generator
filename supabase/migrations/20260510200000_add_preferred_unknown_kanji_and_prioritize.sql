ALTER TABLE profiles
  ADD COLUMN preferred_unknown_kanji_target TEXT DEFAULT 'none',
  ADD COLUMN preferred_prioritize_rare_kanji BOOLEAN DEFAULT true;
