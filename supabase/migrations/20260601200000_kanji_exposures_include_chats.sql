-- ─────────────────────────────────────────────────────────────────────────
-- Chat messages contribute to kanji exposures.
--
-- get_per_chat_payout's kanji arm predicts the kanji a chat mark would add
-- to the user's exposures, but user_underused_kanji (which feeds
-- KanjiContext.kanjiExposures) only counted story kanji. So the predicted
-- kanji delta on a chat's Mark button never actually materialized: marking
-- the chat increased the vocab subtotal (chat-message word_lookups land in
-- get_user_word_encounters) but the kanji subtotal stayed flat. The chat
-- payout's +X tag ended up much higher than the real score gain.
--
-- Union read chat messages into user_underused_kanji on the same shape as
-- the existing story arm, mirroring get_user_word_encounters.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS user_underused_kanji(INT);

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
    UNION ALL
    SELECT
      (regexp_matches(strip_ruby(cm.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch,
      cm.last_read_at
    FROM chat_messages cm
    WHERE cm.user_id = auth.uid()
      AND cm.role = 'assistant'
      AND cm.status = 'complete'
      AND cm.read_count > 0
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

GRANT EXECUTE ON FUNCTION user_underused_kanji(INT) TO authenticated;
