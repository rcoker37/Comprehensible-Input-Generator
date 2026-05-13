-- Consolidate `preferred_*` columns into a single `preferences` JSONB column.
-- Drop the unused `preferred_prioritize_rare_kanji` while we're here.
--
-- Schema lives under nested keys so callers can patch one section at a time:
--   { generator: { model, formality, paragraphs, contentType, unknownKanjiTarget },
--     stories:   { readFilter, paragraphFilter, sortMode } }

ALTER TABLE profiles
  ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE profiles
   SET preferences = jsonb_strip_nulls(
         jsonb_build_object(
           'generator', jsonb_strip_nulls(jsonb_build_object(
             'model',              preferred_model,
             'formality',          preferred_formality,
             'paragraphs',         preferred_paragraphs,
             'contentType',        preferred_content_type,
             'unknownKanjiTarget', preferred_unknown_kanji_target
           ))
         )
       );

ALTER TABLE profiles
  DROP COLUMN preferred_model,
  DROP COLUMN preferred_formality,
  DROP COLUMN preferred_paragraphs,
  DROP COLUMN preferred_content_type,
  DROP COLUMN preferred_unknown_kanji_target,
  DROP COLUMN preferred_prioritize_rare_kanji;

-- Atomic shallow merge: callers send `{ section: { ...full sub-object } }`.
-- jsonb `||` overwrites top-level keys, so always send a section in full
-- rather than partial updates (the client convention).
CREATE OR REPLACE FUNCTION update_preferences(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_new jsonb;
BEGIN
  UPDATE profiles
     SET preferences = preferences || p_patch
   WHERE user_id = auth.uid()
   RETURNING preferences INTO v_new;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION update_preferences(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_preferences(jsonb) TO authenticated;
