ALTER TABLE stories
  ADD COLUMN content_type TEXT NOT NULL DEFAULT 'story'
    CHECK (content_type IN ('story', 'dialogue', 'essay'));

ALTER TABLE profiles
  ADD COLUMN preferred_content_type TEXT DEFAULT 'story';
