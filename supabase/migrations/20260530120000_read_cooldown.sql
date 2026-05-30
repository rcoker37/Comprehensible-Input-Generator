-- ─────────────────────────────────────────────────────────────────────────
-- 24-hour cooldown on mark_story_read / mark_chat_message_read.
--
-- A user can only increment read_count once per 24h window per row. The
-- UPDATE is gated by `last_read_at IS NULL OR last_read_at <= now() -
-- interval '24 hours'`, so an attempt inside the window no-ops at the
-- server. The RPCs still RETURN the current row state (via a follow-up
-- SELECT) so a stale client recovers without an extra round trip.
--
-- The existing 5× cap is preserved by the same LEAST/GREATEST expression
-- on read_count, and last_read_at is still left alone on a no-op so the
-- "marked but nothing happened" case isn't recorded as activity.
--
-- undo_* are intentionally unchanged — they're an explicit user override.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE stories
  SET read_count = LEAST(stories.read_count + 1, GREATEST(stories.read_count, 5)),
      first_read_at = COALESCE(stories.first_read_at, now()),
      last_read_at = CASE WHEN stories.read_count < 5 THEN now() ELSE stories.last_read_at END
  WHERE id = p_story_id
    AND user_id = auth.uid()
    AND (stories.last_read_at IS NULL OR stories.last_read_at <= now() - interval '24 hours');

  RETURN QUERY
  SELECT s.read_count, s.first_read_at, s.last_read_at
  FROM stories s
  WHERE s.id = p_story_id AND s.user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION mark_story_read(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS mark_chat_message_read(BIGINT);

CREATE OR REPLACE FUNCTION mark_chat_message_read(p_message_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE chat_messages
  SET read_count = LEAST(chat_messages.read_count + 1, GREATEST(chat_messages.read_count, 5)),
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = CASE WHEN chat_messages.read_count < 5 THEN now() ELSE chat_messages.last_read_at END
  WHERE id = p_message_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND (chat_messages.last_read_at IS NULL OR chat_messages.last_read_at <= now() - interval '24 hours');

  RETURN QUERY
  SELECT cm.read_count, cm.first_read_at, cm.last_read_at
  FROM chat_messages cm
  WHERE cm.id = p_message_id AND cm.user_id = v_uid AND cm.role = 'assistant';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_chat_message_read(BIGINT) TO authenticated;
