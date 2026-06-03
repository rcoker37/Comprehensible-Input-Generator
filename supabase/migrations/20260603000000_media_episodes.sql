-- ─────────────────────────────────────────────────────────────────────────
-- Media as a third content source: anime (and later VTuber) subtitles.
--
-- A `media_series` is a show; a `media_episode` is one episode (or, for a
-- VTuber series, one stream). An episode maps almost 1:1 onto a story: its
-- furigana-annotated subtitle text lives in `content` (Aozora ruby, written
-- by the annotate-media Edge Function from `raw_content`), "watched" is the
-- binary single-read state (read_count 0/1, like stories), and it is indexed
-- + scored through the exact same word-index pipeline.
--
-- Spoiler handling falls out of the read model for free: an episode only
-- contributes encounters/points once marked watched, and the UI presents
-- episodes in order, so "you only score what you've watched" *is* the
-- spoiler filter — no extra machinery.
--
-- This migration:
--   1. Creates media_series + media_episodes (RLS-scoped, per user).
--   2. Adds media_episode_id as the third polymorphic source on
--      story_word_occurrences / word_lookups (widening the XOR CHECK).
--   3. Adds the media-side read / index RPCs.
--   4. Extends every cross-source aggregation RPC with a media arm, matching
--      the single-read (NUMERIC, read_count) shape from the 20260601* pass.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE media_series (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'anime' CHECK (kind IN ('anime', 'vtuber')),
  jimaku_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE media_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own media series"
  ON media_series FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX media_series_user_activity_idx
  ON media_series (user_id, last_activity_at DESC);

-- A given jimaku source is imported at most once per user.
CREATE UNIQUE INDEX media_series_user_jimaku_uniq
  ON media_series (user_id, jimaku_id) WHERE jimaku_id IS NOT NULL;

CREATE TABLE media_episodes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id BIGINT NOT NULL REFERENCES media_series(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  number INTEGER,
  title TEXT NOT NULL DEFAULT '',
  -- raw_content: the plain (un-annotated) subtitle text, lines joined with \n.
  -- content: the same text with Aozora ruby added by annotate-media. Empty
  -- until annotation completes.
  raw_content TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'annotating', 'complete', 'failed')),
  error_message TEXT,
  translations JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_count INTEGER NOT NULL DEFAULT 0,
  first_read_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  word_index_at TIMESTAMPTZ,
  word_index_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE media_episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own media episodes"
  ON media_episodes FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX media_episodes_series_number_idx
  ON media_episodes (series_id, number);

-- At most one in-flight annotation per (series, number) so a double-import
-- can't create duplicate episode rows.
CREATE UNIQUE INDEX media_episodes_series_number_uniq
  ON media_episodes (series_id, number) WHERE number IS NOT NULL;

COMMENT ON COLUMN media_episodes.raw_content IS
  'Plain subtitle text (no ruby), lines joined with newlines.';
COMMENT ON COLUMN media_episodes.content IS
  'Aozora ruby kanji《reading》 form, written by annotate-media. Empty until annotation completes.';
COMMENT ON COLUMN media_episodes.read_count IS
  'Binary 0/1 watched flag, single-read like stories. Drives encounter contribution.';

-- ─────────────────────────────────────────────────────────────────────────
-- Polymorphic third source on story_word_occurrences / word_lookups
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE story_word_occurrences
  ADD COLUMN media_episode_id BIGINT REFERENCES media_episodes(id) ON DELETE CASCADE;

ALTER TABLE story_word_occurrences
  DROP CONSTRAINT story_word_occurrences_source_xor;
ALTER TABLE story_word_occurrences
  ADD CONSTRAINT story_word_occurrences_source_xor
  CHECK (num_nonnulls(story_id, chat_message_id, media_episode_id) = 1);

CREATE UNIQUE INDEX story_word_occurrences_media_ep_uniq
  ON story_word_occurrences (media_episode_id, start_offset, end_offset)
  WHERE media_episode_id IS NOT NULL;

CREATE INDEX story_word_occurrences_media_ep_headword_idx
  ON story_word_occurrences (user_id, headword)
  WHERE media_episode_id IS NOT NULL;

ALTER TABLE word_lookups
  ADD COLUMN media_episode_id BIGINT REFERENCES media_episodes(id) ON DELETE CASCADE;

ALTER TABLE word_lookups
  DROP CONSTRAINT word_lookups_source_xor;
ALTER TABLE word_lookups
  ADD CONSTRAINT word_lookups_source_xor
  CHECK (num_nonnulls(story_id, chat_message_id, media_episode_id) = 1);

CREATE UNIQUE INDEX word_lookups_media_ep_uniq
  ON word_lookups (user_id, media_episode_id, start_offset, end_offset)
  WHERE media_episode_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Read toggle (analog of mark_story_read / undo_story_read; binary single-read)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_episode_read(p_episode_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE media_episodes
  SET read_count = 1,
      first_read_at = COALESCE(media_episodes.first_read_at, now()),
      last_read_at = now()
  WHERE id = p_episode_id
    AND user_id = v_uid
    AND media_episodes.read_count = 0;

  RETURN QUERY
  SELECT e.read_count, e.first_read_at, e.last_read_at
  FROM media_episodes e
  WHERE e.id = p_episode_id AND e.user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Episode not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_episode_read(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION undo_episode_read(p_episode_id BIGINT)
RETURNS TABLE (read_count INTEGER, first_read_at TIMESTAMPTZ, last_read_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE media_episodes
  SET read_count = 0,
      first_read_at = NULL,
      last_read_at = NULL
  WHERE id = p_episode_id AND user_id = v_uid;

  RETURN QUERY
  SELECT e.read_count, e.first_read_at, e.last_read_at
  FROM media_episodes e
  WHERE e.id = p_episode_id AND e.user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Episode not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_episode_read(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- index_media_episode_words — bulk-replace an episode's word index (analog of
-- index_chat_message_words). No manual-override rows on the media side.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION index_media_episode_words(
  p_episode_id BIGINT,
  p_occurrences JSONB,
  p_version INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM media_episodes WHERE id = p_episode_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Episode not found';
  END IF;

  DELETE FROM story_word_occurrences WHERE media_episode_id = p_episode_id;

  INSERT INTO story_word_occurrences (
    user_id, media_episode_id, start_offset, end_offset, surface, headword, reading, entry_id, manual, is_name
  )
  SELECT
    v_uid,
    p_episode_id,
    (occ->>'start')::INT,
    (occ->>'end')::INT,
    occ->>'surface',
    occ->>'headword',
    NULLIF(occ->>'reading', ''),
    NULLIF(occ->>'entryId', '')::INT,
    FALSE,
    COALESCE((occ->>'isName')::BOOLEAN, FALSE)
  FROM jsonb_array_elements(p_occurrences) AS occ;

  UPDATE media_episodes
  SET word_index_at = v_now, word_index_version = p_version
  WHERE id = p_episode_id;

  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION index_media_episode_words(BIGINT, JSONB, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- reset_media_episode_word_index — analog of reset_chat_word_index but per
-- episode (nulls the stamp so the backfill re-picks it up).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reset_media_episode_word_index(p_episode_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE media_episodes
  SET word_index_at = NULL, word_index_version = NULL
  WHERE id = p_episode_id AND user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Episode not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_media_episode_word_index(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- delete_series — drop a series and (via cascade) its episodes and their
-- story_word_occurrences / word_lookups rows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION delete_series(p_series_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM media_series WHERE id = p_series_id AND user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Series not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_series(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_media_episode_word_encounters — per-occurrence encounter counts for one
-- episode (analog of get_story_word_encounters / get_chat_message_word_...).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_media_episode_word_encounters(p_episode_id BIGINT)
RETURNS TABLE (
  start_offset INT,
  end_offset INT,
  encounters NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH this_episode_occ AS (
    SELECT start_offset, end_offset, headword
    FROM story_word_occurrences
    WHERE user_id = auth.uid() AND media_episode_id = p_episode_id
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
        AND swo.headword IN (SELECT headword FROM this_episode_occ)
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN chat_messages cm ON cm.id = swo.chat_message_id
      WHERE swo.user_id = auth.uid()
        AND swo.chat_message_id IS NOT NULL
        AND cm.read_count > 0
        AND cm.role = 'assistant'
        AND cm.status = 'complete'
        AND swo.headword IN (SELECT headword FROM this_episode_occ)
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN media_episodes e ON e.id = swo.media_episode_id
      WHERE swo.user_id = auth.uid()
        AND swo.media_episode_id IS NOT NULL
        AND e.read_count > 0
        AND e.status = 'complete'
        AND swo.headword IN (SELECT headword FROM this_episode_occ)
    ) t
    GROUP BY headword
  )
  SELECT
    teo.start_offset,
    teo.end_offset,
    COALESCE(ph.encounters, 0)::NUMERIC AS encounters
  FROM this_episode_occ teo
  LEFT JOIN per_headword ph ON ph.headword = teo.headword;
$$;

GRANT EXECUTE ON FUNCTION get_media_episode_word_encounters(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_per_episode_payout — per-episode aggregated counts for the "+X" tag and
-- watch-button hint (analog of get_per_chat_payout). Filtered to UNWATCHED
-- complete episodes: those are the rows the next watch-mark would flip.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_per_episode_payout()
RETURNS TABLE (
  episode_id BIGINT,
  kind TEXT,
  key TEXT,
  count NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    swo.media_episode_id AS episode_id,
    'word'::TEXT,
    swo.headword,
    COUNT(*)::NUMERIC AS count
  FROM story_word_occurrences swo
  JOIN media_episodes e ON e.id = swo.media_episode_id
  WHERE swo.user_id = auth.uid()
    AND swo.media_episode_id IS NOT NULL
    AND e.status = 'complete'
    AND e.read_count = 0
  GROUP BY swo.media_episode_id, swo.headword

  UNION ALL

  SELECT
    e.id AS episode_id,
    'kanji'::TEXT,
    k.ch,
    COUNT(*)::NUMERIC AS count
  FROM media_episodes e
  CROSS JOIN LATERAL (
    SELECT (regexp_matches(strip_ruby(e.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch
  ) k
  WHERE e.user_id = auth.uid()
    AND e.status = 'complete'
    AND e.read_count = 0
  GROUP BY e.id, k.ch;
$$;

GRANT EXECUTE ON FUNCTION get_per_episode_payout() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Cross-source RPCs: add the media arm to each. All match the single-read
-- (NUMERIC, read_count) shape established in 20260601100000.
-- ─────────────────────────────────────────────────────────────────────────

-- get_word_encounters --------------------------------------------------------
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
    UNION ALL
    SELECT 1::NUMERIC AS contribution
    FROM story_word_occurrences swo
    JOIN media_episodes e ON e.id = swo.media_episode_id
    WHERE swo.user_id = auth.uid()
      AND swo.media_episode_id IS NOT NULL
      AND e.read_count > 0
      AND e.status = 'complete'
      AND swo.headword = p_headword
  ) t;
$$;

GRANT EXECUTE ON FUNCTION get_word_encounters(TEXT) TO authenticated;

-- get_user_word_encounters ---------------------------------------------------
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
    UNION ALL
    SELECT swo.headword, 1::NUMERIC AS contribution, e.last_read_at
    FROM story_word_occurrences swo
    JOIN media_episodes e ON e.id = swo.media_episode_id
    WHERE swo.user_id = auth.uid()
      AND swo.media_episode_id IS NOT NULL
      AND e.read_count > 0
      AND e.status = 'complete'
  ) t
  GROUP BY headword;
$$;

GRANT EXECUTE ON FUNCTION get_user_word_encounters() TO authenticated;

-- get_story_word_encounters --------------------------------------------------
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
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN media_episodes e ON e.id = swo.media_episode_id
      WHERE swo.user_id = auth.uid()
        AND swo.media_episode_id IS NOT NULL
        AND e.read_count > 0
        AND e.status = 'complete'
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

-- get_chat_message_word_encounters -------------------------------------------
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
      UNION ALL
      SELECT swo.headword, 1::NUMERIC AS contribution
      FROM story_word_occurrences swo
      JOIN media_episodes e ON e.id = swo.media_episode_id
      WHERE swo.user_id = auth.uid()
        AND swo.media_episode_id IS NOT NULL
        AND e.read_count > 0
        AND e.status = 'complete'
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

-- get_word_usages — add a media arm. The return shape gains
-- media_series_id + media_episode_id so the popover can route to the source.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_word_usages(TEXT);

CREATE OR REPLACE FUNCTION get_word_usages(p_headword TEXT)
RETURNS TABLE (
  occurrence_id BIGINT,
  source_type TEXT,
  story_id BIGINT,
  chat_id BIGINT,
  chat_message_id BIGINT,
  media_series_id BIGINT,
  media_episode_id BIGINT,
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
    NULL::BIGINT AS media_series_id,
    NULL::BIGINT AS media_episode_id,
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
    NULL::BIGINT AS media_series_id,
    NULL::BIGINT AS media_episode_id,
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
  UNION ALL
  SELECT
    swo.id AS occurrence_id,
    'media'::TEXT AS source_type,
    NULL::BIGINT AS story_id,
    NULL::BIGINT AS chat_id,
    NULL::BIGINT AS chat_message_id,
    e.series_id AS media_series_id,
    swo.media_episode_id,
    COALESCE(NULLIF(e.title, ''), ms.title) AS source_title,
    e.content AS source_content,
    e.created_at AS source_created_at,
    swo.start_offset,
    swo.end_offset,
    swo.surface,
    swo.reading,
    wl.looked_up_at,
    COALESCE(wl.lookup_count, 0) AS lookup_count
  FROM story_word_occurrences swo
  JOIN media_episodes e ON e.id = swo.media_episode_id
  JOIN media_series ms ON ms.id = e.series_id
  LEFT JOIN word_lookups wl
    ON wl.user_id = swo.user_id
    AND wl.media_episode_id = swo.media_episode_id
    AND wl.start_offset = swo.start_offset
    AND wl.end_offset = swo.end_offset
  WHERE swo.user_id = auth.uid()
    AND swo.media_episode_id IS NOT NULL
    AND swo.headword = p_headword
    AND e.read_count > 0
    AND e.status = 'complete'
  ORDER BY source_created_at DESC, start_offset ASC;
$$;

GRANT EXECUTE ON FUNCTION get_word_usages(TEXT) TO authenticated;

-- record_word_lookup — add p_media_episode_id (DEFAULT NULL) and widen the
-- XOR check to three sources.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_word_lookup(BIGINT, INT, INT, TEXT, TEXT, TEXT, BIGINT);

CREATE OR REPLACE FUNCTION record_word_lookup(
  p_story_id BIGINT,
  p_start INT,
  p_end INT,
  p_surface TEXT,
  p_headword TEXT,
  p_reading TEXT,
  p_chat_message_id BIGINT DEFAULT NULL,
  p_media_episode_id BIGINT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF num_nonnulls(p_story_id, p_chat_message_id, p_media_episode_id) <> 1 THEN
    RAISE EXCEPTION 'Exactly one of p_story_id, p_chat_message_id, or p_media_episode_id must be set';
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
  ELSIF p_chat_message_id IS NOT NULL THEN
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
  ELSE
    INSERT INTO word_lookups (
      user_id, media_episode_id, start_offset, end_offset, surface, headword, reading
    )
    VALUES (
      v_uid, p_media_episode_id, p_start, p_end, p_surface, p_headword, p_reading
    )
    ON CONFLICT (user_id, media_episode_id, start_offset, end_offset)
      WHERE media_episode_id IS NOT NULL
    DO UPDATE
    SET looked_up_at = now(),
        lookup_count = word_lookups.lookup_count + 1,
        headword = EXCLUDED.headword,
        reading = EXCLUDED.reading,
        surface = EXCLUDED.surface;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION record_word_lookup(BIGINT, INT, INT, TEXT, TEXT, TEXT, BIGINT, BIGINT) TO authenticated;

-- user_underused_kanji — add a media arm to the kanji-exposure union.
-- ----------------------------------------------------------------------------
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
    UNION ALL
    SELECT
      (regexp_matches(strip_ruby(e.content), '[一-龯㐀-䶿]', 'g'))[1] AS ch,
      e.last_read_at
    FROM media_episodes e
    WHERE e.user_id = auth.uid()
      AND e.status = 'complete'
      AND e.read_count > 0
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
