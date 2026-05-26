-- Update the read-side encounter / usage RPCs so chat-message occurrences
-- contribute alongside story occurrences.
--
-- Contribution rules:
--   * Story side: stays read_count-weighted. `read_count > 0` filter still
--     restricts to stories the user has read at least once.
--   * Chat side: +1 per occurrence in any assistant message with
--     `is_read = TRUE AND role = 'assistant' AND status = 'complete'`.
--
-- The UNION ALL pattern keeps both arms independent and avoids "did I count
-- this twice?" footguns from outer joins.

-- ─────────────────────────────────────────────────────────────────────────
-- get_word_encounters(p_headword) — per-headword total for the active card
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
    SELECT 1 AS contribution
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.is_read = TRUE
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
      AND swo.headword = p_headword
  ) t;
$$;

GRANT EXECUTE ON FUNCTION get_word_encounters(TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_user_word_encounters() — every headword, aggregated for the header
-- score and the Stats Browse "last read" sort. last_read_at becomes the
-- MAX across both sources.
-- ─────────────────────────────────────────────────────────────────────────

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
    SELECT swo.headword, 1 AS contribution, cm.read_at AS last_read_at
    FROM story_word_occurrences swo
    JOIN chat_messages cm ON cm.id = swo.chat_message_id
    WHERE swo.user_id = auth.uid()
      AND swo.chat_message_id IS NOT NULL
      AND cm.is_read = TRUE
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
  ) t
  GROUP BY headword;
$$;

GRANT EXECUTE ON FUNCTION get_user_word_encounters() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_story_word_encounters(p_story_id) — per-occurrence encounter counts
-- for a single story. Chat occurrences contribute to each headword's total,
-- so a familiar-from-chat word doesn't look "new" inside a story.
-- ─────────────────────────────────────────────────────────────────────────

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
      SELECT swo.headword, 1 AS contribution
      FROM story_word_occurrences swo
      JOIN chat_messages cm ON cm.id = swo.chat_message_id
      WHERE swo.user_id = auth.uid()
        AND swo.chat_message_id IS NOT NULL
        AND cm.is_read = TRUE
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

-- ─────────────────────────────────────────────────────────────────────────
-- get_word_usages(p_headword) — popover carousel. Returns a unified shape
-- with `source_type` discriminator + nullable id columns for each source.
-- Chat arm filters to read assistant messages, mirroring stories' "I read
-- it" gating.
-- ─────────────────────────────────────────────────────────────────────────

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
    AND cm.is_read = TRUE
    AND cm.role = 'assistant'
    AND cm.status = 'complete'
  ORDER BY source_created_at DESC, start_offset ASC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- record_word_lookup — polymorphic. p_chat_message_id added at the end with
-- DEFAULT NULL so existing 6-arg call sites stay compatible. Exactly one of
-- p_story_id or p_chat_message_id must be set.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS record_word_lookup(BIGINT, INT, INT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION record_word_lookup(
  p_story_id BIGINT,
  p_start INT,
  p_end INT,
  p_surface TEXT,
  p_headword TEXT,
  p_reading TEXT,
  p_chat_message_id BIGINT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF num_nonnulls(p_story_id, p_chat_message_id) <> 1 THEN
    RAISE EXCEPTION 'Exactly one of p_story_id or p_chat_message_id must be set';
  END IF;

  IF p_story_id IS NOT NULL THEN
    INSERT INTO word_lookups (
      user_id, story_id, start_offset, end_offset, surface, headword, reading
    )
    VALUES (
      v_uid, p_story_id, p_start, p_end, p_surface, p_headword, p_reading
    )
    ON CONFLICT (user_id, story_id, start_offset, end_offset)
      WHERE story_id IS NOT NULL
    DO UPDATE
    SET looked_up_at = now(),
        lookup_count = word_lookups.lookup_count + 1,
        headword = EXCLUDED.headword,
        reading = EXCLUDED.reading,
        surface = EXCLUDED.surface;
  ELSE
    INSERT INTO word_lookups (
      user_id, chat_message_id, start_offset, end_offset, surface, headword, reading
    )
    VALUES (
      v_uid, p_chat_message_id, p_start, p_end, p_surface, p_headword, p_reading
    )
    ON CONFLICT (user_id, chat_message_id, start_offset, end_offset)
      WHERE chat_message_id IS NOT NULL
    DO UPDATE
    SET looked_up_at = now(),
        lookup_count = word_lookups.lookup_count + 1,
        headword = EXCLUDED.headword,
        reading = EXCLUDED.reading,
        surface = EXCLUDED.surface;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION record_word_lookup(BIGINT, INT, INT, TEXT, TEXT, TEXT, BIGINT) TO authenticated;
