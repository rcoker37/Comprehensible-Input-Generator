-- ─────────────────────────────────────────────────────────────────────────
-- Chats join stories in the single-read model: every assistant message is
-- binary 0/1 (read or not), the chat-level button toggles all complete
-- assistant messages between those two states, and there is no cap, no
-- cooldown, and no read_weight diminishing-returns weighting anywhere.
--
-- Migration steps:
--   1. Cap legacy chat_messages.read_count to 1.
--   2. mark_chat_message_read / undo_chat_message_read: simple set-to-1 /
--      reset-to-0. Idempotent on a no-op.
--   3. mark_chat_read(p_chat_id): set every complete assistant message
--      with read_count = 0 to read_count = 1 in one UPDATE, returning the
--      changed rows so the client can patch its cache.
--   4. undo_chat_read(p_chat_id, p_message_ids[]): hard reset the named
--      messages to 0 (the client passes either this session's marked IDs
--      or "all current message IDs" when toggling a fully-read chat).
--   5. get_per_chat_payout: flat 1 per occurrence for messages with
--      read_count = 0; no cooldown filter.
--   6. get_word_encounters / get_user_word_encounters /
--      get_chat_message_word_encounters: chat arm uses raw read_count
--      (effectively flat 1 per message with read_count > 0).
--   7. Drop read_weight / read_weight_delta — no remaining callers after
--      this migration.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE chat_messages SET read_count = 1 WHERE read_count > 1;

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
  SET read_count = 1,
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = now()
  WHERE id = p_message_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND chat_messages.read_count = 0;

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
  SET read_count = 0,
      first_read_at = NULL,
      last_read_at = NULL
  WHERE id = p_message_id
    AND user_id = v_uid
    AND role = 'assistant';

  RETURN QUERY
  SELECT cm.read_count, cm.first_read_at, cm.last_read_at
  FROM chat_messages cm
  WHERE cm.id = p_message_id AND cm.user_id = v_uid AND cm.role = 'assistant';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_message_read(BIGINT) TO authenticated;

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
  SET read_count = 1,
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = now()
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND status = 'complete'
    AND chat_messages.read_count = 0
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_chat_read(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS undo_chat_read(BIGINT, BIGINT[]);

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
  SET read_count = 0,
      first_read_at = NULL,
      last_read_at = NULL
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND chat_messages.id = ANY(p_message_ids)
    AND chat_messages.read_count > 0
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_read(BIGINT, BIGINT[]) TO authenticated;

DROP FUNCTION IF EXISTS get_per_chat_payout();

CREATE OR REPLACE FUNCTION get_per_chat_payout()
RETURNS TABLE (
  chat_id BIGINT,
  kind TEXT,
  key TEXT,
  count NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    cm.chat_id,
    'word'::TEXT,
    swo.headword,
    COUNT(*)::NUMERIC AS count
  FROM story_word_occurrences swo
  JOIN chat_messages cm ON cm.id = swo.chat_message_id
  WHERE swo.user_id = auth.uid()
    AND swo.chat_message_id IS NOT NULL
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
    AND cm.read_count = 0
  GROUP BY cm.chat_id, swo.headword

  UNION ALL

  SELECT
    cm.chat_id,
    'kanji'::TEXT,
    k.ch,
    COUNT(*)::NUMERIC AS count
  FROM chat_messages cm
  CROSS JOIN LATERAL (
    SELECT (regexp_matches(strip_ruby(cm.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
  ) k
  WHERE cm.user_id = auth.uid()
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
    AND cm.read_count = 0
  GROUP BY cm.chat_id, k.ch;
$$;

GRANT EXECUTE ON FUNCTION get_per_chat_payout() TO authenticated;

DROP FUNCTION IF EXISTS get_word_encounters(TEXT);

CREATE OR REPLACE FUNCTION get_word_encounters(p_headword TEXT)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(SUM(contribution), 0)::NUMERIC FROM (
    SELECT 1::NUMERIC AS contribution
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
      AND swo.headword = p_headword
    UNION ALL
    SELECT 1::NUMERIC AS contribution
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.read_count > 0
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
      AND swo.headword = p_headword
  ) t;
$$;

GRANT EXECUTE ON FUNCTION get_word_encounters(TEXT) TO authenticated;

DROP FUNCTION IF EXISTS get_user_word_encounters();

CREATE OR REPLACE FUNCTION get_user_word_encounters()
RETURNS TABLE (
  headword TEXT,
  encounters NUMERIC,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    headword,
    COALESCE(SUM(contribution), 0)::NUMERIC AS encounters,
    MAX(last_read_at) AS last_read_at
  FROM (
    SELECT swo.headword, 1::NUMERIC AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT swo.headword, 1::NUMERIC AS contribution, cm.last_read_at
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.read_count > 0
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
  ) t
  GROUP BY headword;
$$;

GRANT EXECUTE ON FUNCTION get_user_word_encounters() TO authenticated;

DROP FUNCTION IF EXISTS get_story_word_encounters(BIGINT);

CREATE OR REPLACE FUNCTION get_story_word_encounters(p_story_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_story_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND story_id = p_story_id
  ),
  per_headword AS (
    SELECT headword, COALESCE(SUM(contribution), 0)::NUMERIC AS encounters
    FROM (
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN stories s ON s.id = swo.story_id
      WHERE swo.user_id = auth.uid()
        AND swo.story_id IS NOT NULL
        AND s.status = 'complete'
        AND s.read_count > 0
        AND swo.headword IN (SELECT headword FROM this_story_occ)
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN chat_messages cm ON cm.id = swo.chat_message_id
      WHERE swo.user_id = auth.uid()
        AND swo.chat_message_id IS NOT NULL
        AND cm.read_count > 0
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
        AND swo.headword IN (SELECT headword FROM this_story_occ)
    ) t
    GROUP BY headword
  )
  SELECT
    tso.start_offset,
    tso.end_offset,
    COALESCE(ph.encounters, 0)::NUMERIC AS encounters
  FROM this_story_occ tso
  LEFT JOIN per_headword ph ON ph.headword = tso.headword;
$$;

GRANT EXECUTE ON FUNCTION get_story_word_encounters(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS get_chat_message_word_encounters(BIGINT);

CREATE OR REPLACE FUNCTION get_chat_message_word_encounters(p_message_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_message_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND chat_message_id = p_message_id
  ),
  per_headword AS (
    SELECT headword, COALESCE(SUM(contribution), 0)::NUMERIC AS encounters
    FROM (
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN stories s ON s.id = swo.story_id
      WHERE swo.user_id = auth.uid()
        AND swo.story_id IS NOT NULL
        AND s.status = 'complete'
        AND s.read_count > 0
        AND swo.headword IN (SELECT headword FROM this_message_occ)
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN chat_messages cm ON cm.id = swo.chat_message_id
      WHERE swo.user_id = auth.uid()
        AND swo.chat_message_id IS NOT NULL
        AND cm.read_count > 0
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
        AND swo.headword IN (SELECT headword FROM this_message_occ)
    ) t
    GROUP BY headword
  )
  SELECT
    tmo.start_offset,
    tmo.end_offset,
    COALESCE(ph.encounters, 0)::NUMERIC AS encounters
  FROM this_message_occ tmo
  LEFT JOIN per_headword ph ON ph.headword = tmo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_chat_message_word_encounters(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS read_weight(INTEGER);
DROP FUNCTION IF EXISTS read_weight_delta(INTEGER);
