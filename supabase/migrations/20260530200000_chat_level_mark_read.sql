-- ─────────────────────────────────────────────────────────────────────────
-- Chat-level mark-as-read fan-out.
--
-- The per-message Mark button on chat assistant replies is going away —
-- replaced by a single button on the chat detail page that marks every
-- complete assistant message at once, subject to the same per-message
-- 5× cap and 24h cooldown that mark_chat_message_read already enforces.
--
-- mark_chat_read(p_chat_id) — fan-out increment. Skips messages at cap
-- (read_count = 5) and inside the cooldown window via the WHERE clause,
-- so RETURNING only emits the messages that actually changed. The chat
-- detail button uses that list to drive a same-session undo just like
-- the StoryReadButton tracks its own click.
--
-- undo_chat_read(p_chat_id, p_message_ids) — targeted decrement for the
-- per-session undo affordance. Floor at 0; clears first_read_at and
-- last_read_at when the count returns to 0 (mirrors the per-message
-- undo's behavior).
--
-- get_per_chat_payout() — per-chat aggregated headword + kanji counts
-- for messages that would actually contribute to the next mark
-- (i.e., not at cap, not on cooldown). Two row shapes share one return:
-- `kind = 'word'` rows carry a headword key, `kind = 'kanji'` rows
-- carry a single character. The client splits them into per-chat
-- (headword → count) and (kanji → count) maps, then feeds them through
-- the existing vocabScoreDelta / kanjiCountsDelta helpers — same scoring
-- as Compositions, just driven by aggregated counts instead of story
-- content.
-- ─────────────────────────────────────────────────────────────────────────

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
  SET read_count = LEAST(chat_messages.read_count + 1, GREATEST(chat_messages.read_count, 5)),
      first_read_at = COALESCE(chat_messages.first_read_at, now()),
      last_read_at = CASE WHEN chat_messages.read_count < 5 THEN now() ELSE chat_messages.last_read_at END
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND status = 'complete'
    AND chat_messages.read_count < 5
    AND (chat_messages.last_read_at IS NULL OR chat_messages.last_read_at <= now() - interval '24 hours')
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_chat_read(BIGINT) TO authenticated;

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
      last_read_at = CASE WHEN chat_messages.read_count <= 1 THEN NULL ELSE chat_messages.last_read_at END
  WHERE chat_id = p_chat_id
    AND user_id = v_uid
    AND role = 'assistant'
    AND id = ANY(p_message_ids)
  RETURNING chat_messages.id, chat_messages.read_count, chat_messages.first_read_at, chat_messages.last_read_at;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_chat_read(BIGINT, BIGINT[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_per_chat_payout()
RETURNS TABLE (
  chat_id BIGINT,
  kind TEXT,
  key TEXT,
  count BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  -- Word arm: per-headword occurrences in messages that would actually
  -- contribute on the next chat-level mark. Reads the same indexed
  -- story_word_occurrences rows that drive popover encounter counts —
  -- the indexer eagerly runs on every complete chat message, so a
  -- freshly-generated reply enters the payout the moment it lands.
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
    AND cm.read_count < 5
    AND (cm.last_read_at IS NULL OR cm.last_read_at <= now() - interval '24 hours')
  GROUP BY cm.chat_id, swo.headword

  UNION ALL

  -- Kanji arm: per-character occurrences in the same message set. Strip
  -- ruby first so the kanji counted are the rendered ones, not whatever
  -- the LLM happened to ruby-annotate. The regex covers CJK Unified
  -- Ideographs (U+4E00..U+9FAF) and Extension A (U+3400..U+4DBF) — same
  -- range as client/src/lib/constants.ts KANJI_REGEX.
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
    AND cm.read_count < 5
    AND (cm.last_read_at IS NULL OR cm.last_read_at <= now() - interval '24 hours')
  GROUP BY cm.chat_id, k.ch;
$$;

GRANT EXECUTE ON FUNCTION get_per_chat_payout() TO authenticated;
