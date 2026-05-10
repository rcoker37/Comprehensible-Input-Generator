-- Remove the per-story TTS audio feature: drop the column and the storage
-- RLS policies that scoped access to the bucket.
--
-- Supabase blocks direct DELETE on storage.objects (and dropping a non-empty
-- bucket fails on the FK from objects), so the `story-audio` bucket and any
-- remaining objects must be cleared from the Supabase dashboard or via the
-- Storage API.

DROP POLICY IF EXISTS "Users read own story audio" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own story audio" ON storage.objects;

ALTER TABLE stories DROP COLUMN IF EXISTS audio;
