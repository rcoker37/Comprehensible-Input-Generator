-- Newer supabase_vault images restrict direct DML on vault.secrets even from
-- SECURITY DEFINER functions; only the vault.* helper functions are allowed.
-- Rewrite set_openrouter_api_key to use vault.update_secret(); rewrite
-- clear_openrouter_api_key to just NULL the profile reference (orphaned vault
-- rows are acceptable — they're encrypted and unused). Drop the cleanup
-- trigger for the same reason.
--
-- Also: set_openrouter_api_key now self-heals when the existing secret_id
-- doesn't exist locally (e.g., a profile row synced from prod whose vault
-- entry wasn't copied) — falls back to create_secret().

CREATE OR REPLACE FUNCTION set_openrouter_api_key(p_key TEXT)
RETURNS VOID AS $$
DECLARE
  v_existing_id UUID;
  v_secret_exists BOOLEAN := false;
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
    SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE id = v_existing_id)
      INTO v_secret_exists;
  END IF;

  IF v_secret_exists THEN
    PERFORM vault.update_secret(v_existing_id, p_key);
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

CREATE OR REPLACE FUNCTION clear_openrouter_api_key()
RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE profiles
    SET openrouter_api_key_secret_id = NULL
    WHERE user_id = v_uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

DROP TRIGGER IF EXISTS profiles_cleanup_openrouter_secret ON profiles;
DROP FUNCTION IF EXISTS cleanup_openrouter_secret();
