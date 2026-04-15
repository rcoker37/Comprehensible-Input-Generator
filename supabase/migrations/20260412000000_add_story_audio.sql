-- Per-story audio: Azure Neural TTS output plus kuromoji-aligned word timings.
--
-- `audio` JSONB shape:
--   {
--     path: string,         -- storage key: "{user_id}/{story_id}.mp3"
--     duration_ms: number,
--     voice: string,        -- e.g., "ja-JP-NanamiNeural"
--     version: number,      -- bump to invalidate cached audio
--     tokens: [{ s, r?, t }] -- surface, optional hiragana reading, start_ms
--   }
--
-- Generated lazily on first play via the generate-audio Edge Function.

ALTER TABLE stories ADD COLUMN audio JSONB;

-- Private storage bucket for generated audio files.
INSERT INTO storage.buckets (id, name, public)
VALUES ('story-audio', 'story-audio', false)
ON CONFLICT (id) DO NOTHING;

-- Users can read (and create signed URLs for) their own audio files.
-- Writes come from the Edge Function using service_role, which bypasses RLS.
CREATE POLICY "Users read own story audio"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'story-audio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Cleanup trigger: when a story is deleted, purge its audio file.
CREATE OR REPLACE FUNCTION cleanup_story_audio()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.audio IS NOT NULL AND OLD.audio ? 'path' THEN
    DELETE FROM storage.objects
      WHERE bucket_id = 'story-audio'
        AND name = OLD.audio->>'path';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

CREATE TRIGGER stories_cleanup_audio
  BEFORE DELETE ON stories
  FOR EACH ROW EXECUTE FUNCTION cleanup_story_audio();
