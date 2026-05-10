-- Background story generation: the Edge Function inserts a stories row with
-- status='generating' immediately, then completes the row asynchronously via
-- EdgeRuntime.waitUntil. The Generator page polls this row until it flips to
-- 'complete' or 'failed'. Stories list / Story Detail filter to 'complete'.

ALTER TABLE stories
  ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('generating', 'complete', 'failed')),
  ADD COLUMN error_message TEXT;

-- In-flight lookup for the Generator page (one user, one in-flight row).
CREATE INDEX idx_stories_user_status ON stories(user_id, status);
