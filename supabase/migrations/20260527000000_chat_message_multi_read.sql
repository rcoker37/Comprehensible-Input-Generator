-- Multi-read tracking for chat messages — analog of stories' multi-read
-- migration (20260508000000). The binary is_read/read_at pair becomes:
--   read_count    — total times marked read (capped at 5)
--   first_read_at — set when the count first goes 0 → 1, never overwritten
--   last_read_at  — refreshed on every increment (renamed from read_at)
--
-- The chat list shows MIN(read_count) across the chat's complete assistant
-- messages, so a chat is "fully read N×" only when every reply has been read
-- at least N times.
--
-- Encounter contribution changes from "+1 per occurrence in a read message"
-- to "+read_count per occurrence", matching how stories already work. The
-- backfill below sets read_count=1 for previously-read messages, so existing
-- totals are preserved on the day of migration.
--
-- Same migration also caps stories at 5 reads going forward — mark_story_read
-- gets the same LEAST(... , GREATEST(read_count, 5)) shape so a legacy story
-- with read_count > 5 isn't decremented by a fresh mark, it just stays put.

ALTER TABLE chat_messages ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN first_read_at TIMESTAMPTZ;
ALTER TABLE chat_messages RENAME COLUMN read_at TO last_read_at;

UPDATE chat_messages
SET read_count = 1, first_read_at = last_read_at
WHERE is_read = TRUE;

-- The lookup index referenced is_read; drop it before dropping the column
-- and recreate using the read_count > 0 predicate.
DROP INDEX IF EXISTS chat_messages_user_headword_lookup_idx;
ALTER TABLE chat_messages DROP COLUMN is_read;
CREATE INDEX chat_messages_user_headword_lookup_idx
  ON chat_messages (user_id)
  WHERE role = 'assistant' AND read_count > 0;

COMMENT ON COLUMN chat_messages.read_count IS
  'Times the user has marked this message read (capped at 5). Encounter weighting matches stories.read_count.';
COMMENT ON COLUMN chat_messages.first_read_at IS
  'Set when read_count first transitions 0 → 1; never overwritten until read_count returns to 0.';
COMMENT ON COLUMN chat_messages.last_read_at IS
  'Refreshed on every increment (was previously read_at, single-shot binary).';

-- ─────────────────────────────────────────────────────────────────────────
-- mark_chat_message_read / undo_chat_message_read — now multi-read, with a
-- server-side cap of 5. Return shape mirrors mark_story_read.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS mark_chat_message_read(BIGINT);
DROP FUNCTION IF EXISTS undo_chat_message_read(BIGINT);

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
  WHERE id = p_message_id AND user_id = v_uid AND role = 'assistant'
  RETURNING chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at
  INTO read_count, first_read_at, last_read_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat message not found';
  END IF;

  RETURN NEXT;
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
  SET read_count = GREATEST(chat_messages.read_count - 1, 0),
      first_read_at = CASE WHEN chat_messages.read_count <= 1 THEN NULL ELSE chat_messages.first_read_at END,
      last_read_at = CASE WHEN chat_messages.read_count <= 1 THEN NULL ELSE chat_messages.last_read_at END
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

-- ─────────────────────────────────────────────────────────────────────────
-- Encounter / usage RPCs — chat arm now weights by cm.read_count instead of
-- the binary is_read flag, and gates on cm.read_count > 0. Story arm is
-- unchanged.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_word_encounters(p_headword TEXT)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(SUM(contribution), 0)::BIGINT FROM (
    SELECT s.read_count AS contribution
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
      AND swo.headword = p_headword
    UNION ALL
    SELECT cm.read_count AS contribution
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
  encounters BIGINT,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    headword,
    COALESCE(SUM(contribution), 0)::BIGINT AS encounters,
    MAX(last_read_at) AS last_read_at
  FROM (
    SELECT swo.headword, s.read_count AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT swo.headword, cm.read_count AS contribution, cm.last_read_at
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

CREATE OR REPLACE FUNCTION get_story_word_encounters(p_story_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_story_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND story_id = p_story_id
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
        AND swo.headword IN (SELECT headword FROM this_story_occ)
      UNION ALL
      SELECT swo.headword, cm.read_count AS contribution
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
    COALESCE(ph.encounters, 0) AS encounters
  FROM this_story_occ tso
  LEFT JOIN per_headword ph ON ph.headword = tso.headword;
$$;

GRANT EXECUTE ON FUNCTION get_story_word_encounters(BIGINT) TO authenticated;

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
      SELECT swo.headword, cm.read_count AS contribution
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
    COALESCE(ph.encounters, 0) AS encounters
  FROM this_message_occ tmo
  LEFT JOIN per_headword ph ON ph.headword = tmo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_chat_message_word_encounters(BIGINT) TO authenticated;

DROP FUNCTION IF EXISTS get_word_usages(TEXT);

CREATE OR REPLACE FUNCTION get_word_usages(p_headword TEXT)
RETURNS TABLE (
  occurrence_id BIGINT,
  source_type TEXT,
  story_id BIGINT,
  chat_id BIGINT,
  chat_message_id BIGINT,
  source_title TEXT,
  source_content TEXT,
  source_created_at TIMESTAMPTZ,
  start_offset INT,
  end_offset INT,
  surface TEXT,
  reading TEXT,
  looked_up_at TIMESTAMPTZ,
  lookup_count INT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.id AS occurrence_id,
    'story'::TEXT AS source_type,
    swo.story_id,
    NULL::BIGINT AS chat_id,
    NULL::BIGINT AS chat_message_id,
    s.title AS source_title,
    s.content AS source_content,
    s.created_at AS source_created_at,
    swo.start_offset,
    swo.end_offset,
    swo.surface,
    swo.reading,
    wl.looked_up_at,
    COALESCE(wl.lookup_count, 0) AS lookup_count
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  LEFT JOIN word_lookups wl
    ON wl.user_id = swo.user_id
    AND wl.story_id = swo.story_id
    AND wl.start_offset = swo.start_offset
    AND wl.end_offset = swo.end_offset
  WHERE swo.user_id = auth.uid()
    AND swo.story_id IS NOT NULL
    AND swo.headword = p_headword
    AND s.status = 'complete'
    AND s.read_count > 0
  UNION ALL
  SELECT
    swo.id AS occurrence_id,
    'chat'::TEXT AS source_type,
    NULL::BIGINT AS story_id,
    cm.chat_id,
    swo.chat_message_id,
    c.title AS source_title,
    cm.content AS source_content,
    cm.created_at AS source_created_at,
    swo.start_offset,
    swo.end_offset,
    swo.surface,
    swo.reading,
    wl.looked_up_at,
    COALESCE(wl.lookup_count, 0) AS lookup_count
  FROM story_word_occurrences swo
  JOIN chat_messages cm ON cm.id = swo.chat_message_id
  JOIN chats c ON c.id = cm.chat_id
  LEFT JOIN word_lookups wl
    ON wl.user_id = swo.user_id
    AND wl.chat_message_id = swo.chat_message_id
    AND wl.start_offset = swo.start_offset
    AND wl.end_offset = swo.end_offset
  WHERE swo.user_id = auth.uid()
    AND swo.chat_message_id IS NOT NULL
    AND swo.headword = p_headword
    AND cm.read_count > 0
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
  ORDER BY source_created_at DESC, start_offset ASC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_chats_with_read_stats — chat list with per-chat min read count across
-- complete assistant messages. The Chats list page uses this so each card
-- can show "✓ Read N×" exactly when every reply has been read at least N
-- times. Pending/failed assistants are excluded so an in-flight reply
-- doesn't pull the MIN to 0. A chat with no complete assistant messages
-- returns NULL — the client renders no tag in that case.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- Cap stories at 5 reads going forward. LEAST(read_count + 1, GREATEST(
-- read_count, 5)) means: increment by 1, but never above max(current, 5).
-- That preserves legacy rows already above 5 (they were uncapped before)
-- while clamping any new growth. last_read_at is left alone on a no-op
-- increment so the "I marked it but nothing happened" case isn't recorded
-- as activity. undo_story_read is unchanged: decrement-with-floor-0 is
-- already correct under the cap.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_story_read(p_story_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE stories
  SET read_count = LEAST(stories.read_count + 1, GREATEST(stories.read_count, 5)),
      first_read_at = COALESCE(stories.first_read_at, now()),
      last_read_at = CASE WHEN stories.read_count < 5 THEN now() ELSE stories.last_read_at END
  WHERE id = p_story_id AND user_id = auth.uid()
  RETURNING stories.read_count, stories.first_read_at, stories.last_read_at;
$$;

CREATE OR REPLACE FUNCTION get_chats_with_read_stats()
RETURNS TABLE (
  id BIGINT,
  title TEXT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  min_assistant_read_count INTEGER
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
    ) AS min_assistant_read_count
  FROM chats c
  WHERE c.user_id = auth.uid()
  ORDER BY c.last_activity_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_chats_with_read_stats() TO authenticated;
