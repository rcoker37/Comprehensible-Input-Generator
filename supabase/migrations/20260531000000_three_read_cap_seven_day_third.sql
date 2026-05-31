-- ─────────────────────────────────────────────────────────────────────────
-- Tighten the read cap from 5× to 3×, and require the 3rd read to be at
-- least 7 days after the 2nd. Reads 1→2 keep the existing 24h cooldown.
--
-- Cooldown becomes count-dependent: when read_count = 2 the next mark is
-- the 3rd read and needs a 7-day wait; at read_count = 1 it's still 24h.
-- The cap and cooldown are folded into one WHERE-clause predicate per
-- RPC, plus a LEAST/GREATEST that keeps legacy rows above the new cap
-- stable (anyone who hit 4 or 5 under the old cap is preserved, but the
-- mark-read button hides them now and they can't grow further).
--
-- get_per_chat_payout uses the same predicate so the per-chat payout
-- only counts messages that would actually contribute on the next mark.
-- The chat-level fan-out (mark_chat_read) and the per-message paths
-- (mark_story_read, mark_chat_message_read) all share the same shape.
--
-- undo_* paths are intentionally unchanged — they're an explicit user
-- override and aren't gated by cap or cooldown.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE stories
  SET read_count = LEAST(stories.read_count + 1, GREATEST(stories.read_count, 3)),
      first_read_at = COALESCE(stories.first_read_at, now()),
      last_read_at = CASE WHEN stories.read_count < 3 THEN now() ELSE stories.last_read_at END
  WHERE id = p_story_id
    AND user_id = auth.uid()
    AND stories.read_count < 3
    AND (
      stories.last_read_at IS NULL
      OR stories.last_read_at <= now() - (
        CASE WHEN stories.read_count >= 2 THEN interval '7 days' ELSE interval '24 hours' END
      )
    );

  RETURN QUERY
  SELECT s.read_count, s.first_read_at, s.last_read_at
  FROM stories s
  WHERE s.id = p_story_id AND s.user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION mark_story_read(BIGINT) TO authenticated;

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
  SET read_count = LEAST(chat_messages.read_count + 1, GREATEST(chat_messages.read_count, 3)),
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = CASE WHEN chat_messages.read_count < 3 THEN now() ELSE chat_messages.last_read_at END
  WHERE id = p_message_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND chat_messages.read_count < 3
    AND (
      chat_messages.last_read_at IS NULL
      OR chat_messages.last_read_at <= now() - (
        CASE WHEN chat_messages.read_count >= 2 THEN interval '7 days' ELSE interval '24 hours' END
      )
    );

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

CREATE OR REPLACE FUNCTION mark_chat_read(p_chat_id BIGINT)
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
  SET read_count = LEAST(chat_messages.read_count + 1, GREATEST(chat_messages.read_count, 3)),
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = CASE WHEN chat_messages.read_count < 3 THEN now() ELSE chat_messages.last_read_at END
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND status = 'complete'
    AND chat_messages.read_count < 3
    AND (
      chat_messages.last_read_at IS NULL
      OR chat_messages.last_read_at <= now() - (
        CASE WHEN chat_messages.read_count >= 2 THEN interval '7 days' ELSE interval '24 hours' END
      )
    )
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_chat_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION get_per_chat_payout()
RETURNS TABLE (
  chat_id BIGINT,
  kind TEXT,
  key TEXT,
  count BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  -- Word arm: per-headword occurrences in messages that would actually
  -- contribute on the next chat-level mark. Filters mirror the
  -- mark_chat_read predicate above — under-cap AND off-cooldown (where
  -- cooldown is 7d when the next mark is the 3rd read, 24h otherwise).
  SELECT
    cm.chat_id,
    'word'::TEXT,
    swo.headword,
    COUNT(*)::BIGINT
  FROM story_word_occurrences swo
  JOIN chat_messages cm ON cm.id = swo.chat_message_id
  WHERE swo.user_id = auth.uid()
    AND swo.chat_message_id IS NOT NULL
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
    AND cm.read_count < 3
    AND (
      cm.last_read_at IS NULL
      OR cm.last_read_at <= now() - (
        CASE WHEN cm.read_count >= 2 THEN interval '7 days' ELSE interval '24 hours' END
      )
    )
  GROUP BY cm.chat_id, swo.headword

  UNION ALL

  SELECT
    cm.chat_id,
    'kanji'::TEXT,
    k.ch,
    COUNT(*)::BIGINT
  FROM chat_messages cm
  CROSS JOIN LATERAL (
    SELECT (regexp_matches(strip_ruby(cm.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
  ) k
  WHERE cm.user_id = auth.uid()
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
    AND cm.read_count < 3
    AND (
      cm.last_read_at IS NULL
      OR cm.last_read_at <= now() - (
        CASE WHEN cm.read_count >= 2 THEN interval '7 days' ELSE interval '24 hours' END
      )
    )
  GROUP BY cm.chat_id, k.ch;
$$;

GRANT EXECUTE ON FUNCTION get_per_chat_payout() TO authenticated;
