-- ─────────────────────────────────────────────────────────────────────────
-- Add `last_read_at` to get_chats_with_read_stats so the Chats list page
-- can sort by "Last Read" without lazy-loading every chat's messages.
--
-- Defined as MAX(last_read_at) across complete assistant messages —
-- mirrors how `min_assistant_read_count` is computed, just MAX instead
-- of MIN, and same role/status filter. NULL when the chat has no
-- complete assistant messages or none of them have been marked read.
--
-- Adding a column to a function's RETURNS TABLE shape isn't a
-- compatible CREATE OR REPLACE change, so the function is dropped and
-- recreated.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_chats_with_read_stats();

CREATE OR REPLACE FUNCTION get_chats_with_read_stats()
RETURNS TABLE (
  id BIGINT,
  title TEXT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  min_assistant_read_count INTEGER,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    c.id,
    c.title,
    c.created_at,
    c.last_activity_at,
    (
      SELECT MIN(cm.read_count)::INTEGER
      FROM chat_messages cm
      WHERE cm.chat_id = c.id
        AND cm.user_id = auth.uid()
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
    ) AS min_assistant_read_count,
    (
      SELECT MAX(cm.last_read_at)
      FROM chat_messages cm
      WHERE cm.chat_id = c.id
        AND cm.user_id = auth.uid()
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
    ) AS last_read_at
  FROM chats c
  WHERE c.user_id = auth.uid()
  ORDER BY c.last_activity_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_chats_with_read_stats() TO authenticated;
