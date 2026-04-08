ALTER TABLE profiles
  ADD COLUMN preferred_formality TEXT DEFAULT 'polite',
  ADD COLUMN preferred_grammar_level INTEGER DEFAULT 2,
  ADD COLUMN preferred_paragraphs INTEGER DEFAULT 5;

ALTER TABLE profiles
  ALTER COLUMN preferred_model SET DEFAULT 'openai/o4-mini';
