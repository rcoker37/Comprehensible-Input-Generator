-- Supabase blocks direct DELETE on storage.objects (even via SECURITY DEFINER
-- trigger), so the cleanup_story_audio trigger added in 20260412000000 fails
-- when deleting a story that has audio. Drop the trigger and let the client
-- remove the storage object via the Storage API before deleting the row.

DROP TRIGGER IF EXISTS stories_cleanup_audio ON stories;
DROP FUNCTION IF EXISTS cleanup_story_audio();

CREATE POLICY "Users delete own story audio"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'story-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
