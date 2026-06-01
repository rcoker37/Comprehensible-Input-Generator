-- ─────────────────────────────────────────────────────────────────────────
-- Diminishing returns for multiple reads. A story or chat message marked
-- read N times no longer contributes `N` to its kanji exposure / vocab
-- encounter totals; instead each successive read pays half as much as the
-- previous one:
--
--   read 1 → +1.0   (cumulative 1.0)
--   read 2 → +0.5   (cumulative 1.5)
--   read 3 → +0.25  (cumulative 1.75)
--
-- The closed form is `read_weight(N) = 2 * (1 - 0.5^N)`, asymptotic to 2,
-- so any legacy row above the 3× cap is preserved monotonically. The
-- per-read marginal weight `read_weight_delta(N) = 0.5^N` (= the gain from
-- reading once more from current count N) powers the Compositions and
-- Chats per-card payout tags.
--
-- All encounter / exposure RPCs change their `encounters` / `exposures` /
-- `count` columns from BIGINT to NUMERIC because the weighted sums are
-- fractional. supabase-js returns NUMERIC as JS `number` for values this
-- small, so the client `Number(r.encounters)` conversions still apply
-- without change. Display sites that printed these as integers (popover
-- "N encounters", KanjiInlineDetail card "N×") now round for display.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION read_weight(rc INTEGER) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rc <= 0 THEN 0::NUMERIC
    ELSE 2 - 2 * power(0.5::numeric, rc)
  END;
$$;

CREATE OR REPLACE FUNCTION read_weight_delta(rc INTEGER) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rc >= 3 THEN 0::NUMERIC
    WHEN rc < 0 THEN 0::NUMERIC
    ELSE power(0.5::numeric, rc)
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- user_underused_kanji — per-kanji exposure across the user's read stories,
-- weighted by read_weight(read_count) instead of raw read_count.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS user_underused_kanji(INT);

CREATE OR REPLACE FUNCTION user_underused_kanji(p_limit INT DEFAULT 20)
RETURNS TABLE (kanji TEXT, exposures NUMERIC, last_read_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH read_text AS (
    SELECT strip_ruby(content) AS t, read_count, last_read_at
    FROM stories
    WHERE user_id = auth.uid() AND read_count > 0
  ),
  chars AS (
    SELECT (regexp_matches(t, '[一-龯㐀-䶿]', 'g'))[1] AS ch, read_count, last_read_at
    FROM read_text
  ),
  counts AS (
    SELECT ch, SUM(read_weight(read_count))::NUMERIC AS n, MAX(last_read_at) AS last_read_at
    FROM chars
    GROUP BY ch
  )
  SELECT k.character, c.n AS exposures, c.last_read_at
  FROM counts c
  JOIN kanji k ON k.character = c.ch
  ORDER BY c.n ASC, k.grade DESC, k.character
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION user_underused_kanji(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_word_encounters / get_user_word_encounters / get_story_word_encounters
-- / get_chat_message_word_encounters — replace `read_count AS contribution`
-- with `read_weight(read_count)`. Encounters columns become NUMERIC.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_word_encounters(TEXT);

CREATE OR REPLACE FUNCTION get_word_encounters(p_headword TEXT)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(SUM(contribution), 0)::NUMERIC FROM (
    SELECT read_weight(s.read_count) AS contribution
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
      AND swo.headword = p_headword
    UNION ALL
    SELECT read_weight(cm.read_count) AS contribution
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
    SELECT swo.headword, read_weight(s.read_count) AS contribution, s.last_read_at
    FROM story_word_occurrences swo
    JOIN stories s ON s.id = swo.story_id
    WHERE swo.user_id = auth.uid()
      AND swo.story_id IS NOT NULL
      AND s.status = 'complete'
      AND s.read_count > 0
    UNION ALL
    SELECT swo.headword, read_weight(cm.read_count) AS contribution, cm.last_read_at
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
      SELECT swo.headword, read_weight(s.read_count) AS contribution
      FROM story_word_occurrences swo
      JOIN stories s ON s.id = swo.story_id
      WHERE swo.user_id = auth.uid()
        AND swo.story_id IS NOT NULL
        AND s.status = 'complete'
        AND s.read_count > 0
        AND swo.headword IN (SELECT headword FROM this_story_occ)
      UNION ALL
      SELECT swo.headword, read_weight(cm.read_count) AS contribution
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
      SELECT swo.headword, read_weight(s.read_count) AS contribution
      FROM story_word_occurrences swo
      JOIN stories s ON s.id = swo.story_id
      WHERE swo.user_id = auth.uid()
        AND swo.story_id IS NOT NULL
        AND s.status = 'complete'
        AND s.read_count > 0
        AND swo.headword IN (SELECT headword FROM this_message_occ)
      UNION ALL
      SELECT swo.headword, read_weight(cm.read_count) AS contribution
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

-- ─────────────────────────────────────────────────────────────────────────
-- get_per_story_word_occurrences — per-card payout on Compositions. The
-- delta from reading once more is now `read_weight(rc+1) - read_weight(rc)`
-- = `0.5^rc` per occurrence, so each row's raw count is pre-multiplied
-- here. Stories at the cap contribute 0 (matches the Stories.tsx hide).
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_per_story_word_occurrences();

CREATE OR REPLACE FUNCTION get_per_story_word_occurrences()
RETURNS TABLE (
  story_id BIGINT,
  headword TEXT,
  occurrences NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.story_id,
    swo.headword,
    (COUNT(*) * read_weight_delta(s.read_count))::NUMERIC AS occurrences
  FROM story_word_occurrences swo
  JOIN stories s ON s.id = swo.story_id
  WHERE swo.user_id = auth.uid()
    AND s.status = 'complete'
  GROUP BY swo.story_id, swo.headword, s.read_count;
$$;

GRANT EXECUTE ON FUNCTION get_per_story_word_occurrences() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_per_chat_payout — same shape as before but each per-message
-- contribution is multiplied by `read_weight_delta(cm.read_count)`. The
-- under-cap / off-cooldown WHERE clauses are preserved, so a message at
-- the 3× cap or inside its cooldown still contributes 0.
-- ─────────────────────────────────────────────────────────────────────────

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
    SUM(read_weight_delta(cm.read_count))::NUMERIC AS count
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
    SUM(read_weight_delta(cm.read_count))::NUMERIC AS count
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
