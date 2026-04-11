-- Security hardening:
--   1. Fix get_user_kanji RPC authorization bypass (arbitrary user_id -> auth.uid())
--   2. Move OpenRouter API keys from plaintext profiles column into Supabase Vault

-- =========================================================
-- #1: get_user_kanji RPC — use auth.uid() instead of param
-- =========================================================

DROP FUNCTION IF EXISTS get_user_kanji(UUID);

CREATE OR REPLACE FUNCTION get_user_kanji()
RETURNS TABLE (
  "character" TEXT,
  grade INTEGER,
  jlpt INTEGER,
  meanings TEXT,
  readings_on TEXT,
  readings_kun TEXT,
  known BOOLEAN
) AS $$
  SELECT k."character", k.grade, k.jlpt, k.meanings, k.readings_on, k.readings_kun,
         COALESCE(uk.known, false) AS known
  FROM kanji k
  LEFT JOIN user_kanji uk
    ON uk."character" = k."character"
   AND uk.user_id = auth.uid()
  ORDER BY k.grade, k."character";
$$ LANGUAGE sql STABLE SECURITY INVOKER;

GRANT EXECUTE ON FUNCTION get_user_kanji() TO authenticated;

-- =========================================================
-- #2: Move OpenRouter API keys into Supabase Vault
-- =========================================================

-- Vault extension (usually pre-enabled on Supabase projects, but be explicit)
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault CASCADE;

-- Add reference column (UUID of the vault secret)
ALTER TABLE profiles
  ADD COLUMN openrouter_api_key_secret_id UUID;

-- RPC: set (create or update) the caller's OpenRouter API key
CREATE OR REPLACE FUNCTION set_openrouter_api_key(p_key TEXT)
RETURNS VOID AS $$
DECLARE
  v_existing_id UUID;
  v_new_id UUID;
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_key IS NULL OR length(btrim(p_key)) = 0 THEN
    RAISE EXCEPTION 'API key cannot be empty';
  END IF;

  SELECT openrouter_api_key_secret_id
    INTO v_existing_id
    FROM profiles
    WHERE user_id = v_uid;

  IF v_existing_id IS NOT NULL THEN
    UPDATE vault.secrets
      SET secret = p_key
      WHERE id = v_existing_id;
  ELSE
    v_new_id := vault.create_secret(
      p_key,
      'openrouter_api_key_' || v_uid::text,
      'OpenRouter API key for user ' || v_uid::text
    );
    UPDATE profiles
      SET openrouter_api_key_secret_id = v_new_id
      WHERE user_id = v_uid;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

-- RPC: clear the caller's OpenRouter API key
CREATE OR REPLACE FUNCTION clear_openrouter_api_key()
RETURNS VOID AS $$
DECLARE
  v_existing_id UUID;
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT openrouter_api_key_secret_id
    INTO v_existing_id
    FROM profiles
    WHERE user_id = v_uid;

  IF v_existing_id IS NOT NULL THEN
    UPDATE profiles
      SET openrouter_api_key_secret_id = NULL
      WHERE user_id = v_uid;
    DELETE FROM vault.secrets WHERE id = v_existing_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

-- RPC: decrypt the API key — service_role only (called from Edge Functions)
CREATE OR REPLACE FUNCTION get_openrouter_api_key_for_user(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_secret_id UUID;
  v_key TEXT;
BEGIN
  SELECT openrouter_api_key_secret_id
    INTO v_secret_id
    FROM profiles
    WHERE user_id = p_user_id;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret
    INTO v_key
    FROM vault.decrypted_secrets
    WHERE id = v_secret_id;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

-- Cleanup: delete vault secret when profile row is deleted
CREATE OR REPLACE FUNCTION cleanup_openrouter_secret()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.openrouter_api_key_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.openrouter_api_key_secret_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

CREATE TRIGGER profiles_cleanup_openrouter_secret
  BEFORE DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION cleanup_openrouter_secret();

-- Drop the plaintext column — existing users must re-enter their key
ALTER TABLE profiles DROP COLUMN openrouter_api_key;

-- Permissions
REVOKE EXECUTE ON FUNCTION get_openrouter_api_key_for_user(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_openrouter_api_key_for_user(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_openrouter_api_key_for_user(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION set_openrouter_api_key(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION clear_openrouter_api_key() TO authenticated;
