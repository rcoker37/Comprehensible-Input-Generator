-- ─────────────────────────────────────────────────────────────────────────
-- Remove read chat messages from vocab/kanji scoring.
--
-- The Chats feature is hidden from the UX behind the client `CHATS_ENABLED`
-- flag (lib/constants.ts). While it's off, read assistant chat messages should
-- no longer contribute to the user's scoring. Every shared scoring RPC below
-- currently UNIONs a `chat_messages` arm onto its `stories` arm; this migration
-- redefines each to the stories-only version (the chat arm is deleted).
--
-- Nothing else about chats is touched: the chat tables, the chat-specific RPCs
-- (get_per_chat_payout, get_chats_with_read_stats, mark/undo_chat_read,
-- index_chat_message_words, get_chat_message_word_encounters, delete_chat,
-- reset_chat_word_index, …), the `chat-message` Edge Function, and all client
-- chat code stay in place, just unused. `story_word_occurrences` rows keyed on
-- chat messages remain too — they're simply no longer aggregated here.
--
-- TO REVIVE CHATS: flip `CHATS_ENABLED` back to true AND add a migration that
-- restores the chat UNION arm to each function below. The with-chats versions
-- are the immediately-preceding definitions in git history:
--   get_user_word_encounters / get_chat_message_word_encounters  → 20260531120000
--   user_underused_kanji                                         → 20260601200000
--   get_review_queue                                             → 20260611000000
--   get_word_encounters / get_story_word_encounters              → 20260601100000
--   get_word_usages                                              → 20260527000000
--
-- CREATE OR REPLACE preserves each function's existing grants, so no re-GRANT
-- is needed.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Vocab subtotal of the header score.
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
    SELECT swo.headword, read_weight(s.read_count) AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
  ) t
  GROUP BY headword;
$$;

-- 2. Kanji exposures / kanji subtotal of the header score + Browse sort.
CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures NUMERIC, last_read_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH chars AS (
    SELECT
      (regexp_matches(strip_ruby(s.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch,
      s.last_read_at
    FROM stories s
    WHERE s.user_id = auth.uid()
      AND s.status = 'complete'
      AND s.read_count > 0
  ),
  counts AS (
    SELECT ch, COUNT(*)::NUMERIC AS n, MAX(last_read_at) AS last_read_at
    FROM chars
    GROUP BY ch
  )
  SELECT k.character, c.n AS exposures, c.last_read_at
  FROM counts c
  JOIN kanji k ON k.character = c.ch
  ORDER BY c.n ASC, k.grade DESC, k.character
  LIMIT p_limit;
$$;

-- 3. Review tab queue (under-10 encounters + rare-kanji gate).
CREATE OR REPLACE FUNCTION get_review_queue()
RETURNS TABLE (
  headword TEXT,
  last_read_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH occ AS (
    SELECT swo.headword, swo.surface, 1::NUMERIC AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
  ),
  kanji_chars AS (
    SELECT (regexp_matches(strip_ruby(s.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
    FROM stories s
    WHERE s.user_id = auth.uid()
      AND s.status = 'complete'
      AND s.read_count > 0
  ),
  rare_kanji AS (
    SELECT ch FROM kanji_chars GROUP BY ch HAVING COUNT(*) < 10
  ),
  totals AS (
    SELECT
      headword,
      string_agg(DISTINCT surface, '') AS surfaces,
      SUM(contribution) AS encounters,
      MAX(last_read_at) AS last_read_at
    FROM occ
    GROUP BY headword
    HAVING SUM(contribution) < 10
  )
  SELECT t.headword, t.last_read_at
  FROM totals t
  LEFT JOIN word_reviews wr
    ON wr.user_id = auth.uid() AND wr.headword = t.headword
  WHERE (wr.eligible_at IS NULL OR wr.eligible_at <= now())
    AND EXISTS (
      SELECT 1 FROM rare_kanji rk
      WHERE position(rk.ch IN t.surfaces) > 0
    );
$$;

-- 4. Single-word encounter total (WordPopover "N encounters" tag).
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
  ) t;
$$;

-- 5. Per-occurrence encounter counts for the story zero-encounter underline.
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

-- 6. WordPopover "other usages" carousel (now story usages only).
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
  ORDER BY source_created_at DESC, start_offset ASC;
$$;
