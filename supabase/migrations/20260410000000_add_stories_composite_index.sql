-- Replace separate indexes with a composite index that serves the primary
-- query pattern: WHERE user_id = X ORDER BY created_at DESC
DROP INDEX IF EXISTS idx_stories_user;
DROP INDEX IF EXISTS idx_stories_created;

CREATE INDEX idx_stories_user_created ON stories(user_id, created_at DESC);
