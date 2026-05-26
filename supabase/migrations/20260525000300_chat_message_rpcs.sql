-- Chat-message-side RPCs. Each is a focused mirror of an existing
-- story RPC; the two paths stay parallel rather than merged into one
-- polymorphic function to avoid mass-edits on the story call sites.

-- ─────────────────────────────────────────────────────────────────────────
-- index_chat_message_words — bulk-replace the chat message's word index
-- (analog of index_story_words). Manual rows don't exist for chat messages
-- yet (no override editor), so this is simpler: just delete every row for
-- the message and re-insert.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION index_chat_message_words(
  p_message_id BIGINT,
  p_occurrences JSONB,
  p_version INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE id = p_message_id AND user_id = v_uid AND role = 'assistant'
  ) THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;

  DELETE FROM story_word_occurrences WHERE chat_message_id = p_message_id;

  INSERT INTO story_word_occurrences (
    user_id, chat_message_id, start_offset, end_offset, surface, headword, reading, entry_id, manual, is_name
  )
  SELECT
    v_uid,
    p_message_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', ''),
    NULLIF(occ->>'entryId', '')::INT,
    FALSE,
    COALESCE((occ->>'isName')::BOOLEAN, FALSE)
  FROM jsonb_array_elements(p_occurrences) AS occ;

  UPDATE chat_messages
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_message_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_chat_message_words(BIGINT, JSONB, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_chat_message_word_encounters — per-occurrence encounter counts for a
-- single chat message. Same UNION-across-sources pattern as the story
-- analog (in 20260525000200) so a familiar-from-stories word doesn't look
-- "new" inside a chat reply either.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_chat_message_word_encounters(p_message_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_message_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND chat_message_id = p_message_id
  ),
  per_headword AS (
    SELECT headword, COALESCE(SUM(contribution), 0)::BIGINT AS encounters
    FROM (
      SELECT swo.headword, s.read_count AS contribution
      FROM story_word_occurrences swo
      JOIN stories s ON s.id = swo.story_id
      WHERE swo.user_id = auth.uid()
        AND swo.story_id IS NOT NULL
        AND s.status = 'complete'
        AND s.read_count > 0
        AND swo.headword IN (SELECT headword FROM this_message_occ)
      UNION ALL
      SELECT swo.headword, 1 AS contribution
      FROM story_word_occurrences swo
      JOIN chat_messages cm ON cm.id = swo.chat_message_id
      WHERE swo.user_id = auth.uid()
        AND swo.chat_message_id IS NOT NULL
        AND cm.is_read = TRUE
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
        AND swo.headword IN (SELECT headword FROM this_message_occ)
    ) t
    GROUP BY headword
  )
  SELECT
    tmo.start_offset,
    tmo.end_offset,
    COALESCE(ph.encounters, 0) AS encounters
  FROM this_message_occ tmo
  LEFT JOIN per_headword ph ON ph.headword = tmo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_chat_message_word_encounters(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- mark_chat_message_read / undo_chat_message_read — binary read toggle.
-- The "Mark as Read" pill on each assistant message routes through these.
-- Encounter contribution flips with the flag (see get_word_encounters and
-- siblings).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_chat_message_read(p_message_id BIGINT)
RETURNS TABLE (is_read BOOLEAN, read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE chat_messages
  SET is_read = TRUE, read_at = now()
  WHERE id = p_message_id AND user_id = v_uid AND role = 'assistant'
  RETURNING chat_messages.is_read, chat_messages.read_at
  INTO is_read, read_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_chat_message_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION undo_chat_message_read(p_message_id BIGINT)
RETURNS TABLE (is_read BOOLEAN, read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE chat_messages
  SET is_read = FALSE, read_at = NULL
  WHERE id = p_message_id AND user_id = v_uid AND role = 'assistant'
  RETURNING chat_messages.is_read, chat_messages.read_at
  INTO is_read, read_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_message_read(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- reset_chat_word_index — analog of "reset overrides" on stories, but for
-- chats. Nulls the index stamp on every assistant message in the chat so
-- the backfill picks them up on its next pass.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reset_chat_word_index(p_chat_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM chats WHERE id = p_chat_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Chat not found';
  END IF;

  UPDATE chat_messages
  SET word_index_at = NULL, word_index_version = NULL
  WHERE chat_id = p_chat_id AND role = 'assistant';
END;
$$;

GRANT EXECUTE ON FUNCTION reset_chat_word_index(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- delete_chat — explicit helper so the client can drop a chat in one call.
-- Cascade chain: chats → chat_messages → story_word_occurrences /
-- word_lookups (the chat-message-keyed rows).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION delete_chat(p_chat_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM chats WHERE id = p_chat_id AND user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_chat(BIGINT) TO authenticated;
