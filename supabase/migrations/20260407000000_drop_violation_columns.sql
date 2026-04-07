-- Furigana is now generated client-side via kuromoji; violation columns are no longer needed
ALTER TABLE stories DROP COLUMN IF EXISTS violations;
ALTER TABLE stories DROP COLUMN IF EXISTS violation_readings;
