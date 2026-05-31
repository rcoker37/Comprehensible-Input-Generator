-- ─────────────────────────────────────────────────────────────────────────
-- Undoing a read increment now resets the 24h cooldown.
--
-- The cooldown introduced in 20260530120000 is keyed entirely on
-- last_read_at (both server-side in the mark_* RPCs and client-side in
-- lib/readCooldown.ts). The undo RPCs previously only cleared last_read_at
-- on the 1 → 0 transition, so undoing a mark that left read_count >= 1
-- (e.g. 2 → 1) left last_read_at stamped at the just-undone mark — keeping
-- the row stuck on cooldown and blocking an immediate re-mark even though
-- the increment it came from was taken back.
--
-- Fix: every undo clears last_read_at unconditionally, which resets the
-- cooldown so the row can be marked again right away. first_read_at keeps
-- its existing semantics — cleared only when read_count returns to 0.
-- (We don't retain the prior read's timestamp, so NULL is the honest
-- "no active cooldown" value here; undo is a same-session take-back of a
-- mark whose previous last_read_at is unknown anyway.)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION undo_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE stories
  SET read_count = GREATEST(stories.read_count - 1, 0),
      first_read_at = CASE WHEN stories.read_count <= 1 THEN NULL ELSE stories.first_read_at END,
      last_read_at = NULL
  WHERE id = p_story_id AND user_id = auth.uid()
  RETURNING stories.read_count, stories.first_read_at, stories.last_read_at;
$$;

GRANT EXECUTE ON FUNCTION undo_story_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION undo_chat_message_read(p_message_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE chat_messages
  SET read_count = GREATEST(chat_messages.read_count - 1, 0),
      first_read_at = CASE WHEN chat_messages.read_count <= 1 THEN NULL ELSE chat_messages.first_read_at END,
      last_read_at = NULL
  WHERE id = p_message_id AND user_id = v_uid AND role = 'assistant'
  RETURNING chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at
  INTO read_count, first_read_at, last_read_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_message_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION undo_chat_read(p_chat_id BIGINT, p_message_ids BIGINT[])
RETURNS TABLE (
  message_id BIGINT,
  read_count INTEGER,
  first_read_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  UPDATE chat_messages
  SET read_count = GREATEST(chat_messages.read_count - 1, 0),
      first_read_at = CASE WHEN chat_messages.read_count <= 1 THEN NULL ELSE chat_messages.first_read_at END,
      last_read_at = NULL
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND id = ANY(p_message_ids)
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_read(BIGINT, BIGINT[]) TO authenticated;
