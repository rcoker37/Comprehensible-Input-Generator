-- Add columns for tracking kanji violations and their context-correct readings
ALTER TABLE stories ADD COLUMN violations TEXT[] DEFAULT '{}';
ALTER TABLE stories ADD COLUMN violation_readings JSONB DEFAULT '{}';
