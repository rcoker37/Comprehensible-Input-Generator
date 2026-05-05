-- Drop the constraint first so data migrations can use the new values
ALTER TABLE stories DROP CONSTRAINT stories_content_type_check;

-- Migrate existing data to new values
UPDATE stories SET content_type = 'fiction'    WHERE content_type IN ('story', 'dialogue', 'anime');
UPDATE stories SET content_type = 'nonfiction' WHERE content_type = 'essay';

UPDATE profiles SET preferred_content_type = 'fiction'    WHERE preferred_content_type IN ('story', 'dialogue', 'anime');
UPDATE profiles SET preferred_content_type = 'nonfiction' WHERE preferred_content_type = 'essay';

-- Re-add the CHECK constraint with new values
ALTER TABLE stories ADD CONSTRAINT stories_content_type_check
  CHECK (content_type IN ('fiction', 'nonfiction'));
ALTER TABLE stories ALTER COLUMN content_type SET DEFAULT 'fiction';

-- Update the default on profiles (it had no CHECK constraint)
ALTER TABLE profiles ALTER COLUMN preferred_content_type SET DEFAULT 'fiction';
