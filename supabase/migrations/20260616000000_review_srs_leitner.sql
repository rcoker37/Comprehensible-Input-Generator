-- ─────────────────────────────────────────────────────────────────────────
-- Review tab: replace the cooldown + hide model with a Leitner SRS.
--
-- The old model had two advance actions: Next (fixed 24h cooldown) and Hide
-- (eligible_at = 'infinity', the word stays out of the queue until manually
-- unhidden). The Review tab is now a pass/fail SRS:
--
--   * record_word_review takes a boolean `p_passed` instead of a cooldown.
--   * A per-word `box` (0..5) walks a fixed Leitner ladder of intervals.
--     Pass advances one box (interval grows); fail resets to box 0 (due in
--     one day — no in-session re-show).
--   * The "hide forever" concept is gone, so get_mastered_words /
--     clear_word_review are dropped and any leftover 'infinity' rows are
--     reset back into the queue.
--
-- get_review_queue is unchanged: it already filters on eligible_at, which is
-- all the ladder feeds. The queue still organically ages words out at 10
-- encounters, so the ladder caps at 30 days rather than growing unbounded.
-- ─────────────────────────────────────────────────────────────────────────

-- Box on the Leitner ladder. 0 = new / just-lapsed; each pass climbs one
-- rung. Existing rows start at 0 (treated as new on their next review).
ALTER TABLE word_reviews
  ADD COLUMN box SMALLINT NOT NULL DEFAULT 0;

-- Hide is gone — pull every previously-hidden word back into the queue.
UPDATE word_reviews
SET eligible_at = now()
WHERE eligible_at = 'infinity'::TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────
-- record_word_review(headword, passed): Leitner state transition.
--
-- STEPS is the per-box interval in days. A pass climbs one box (capped);
-- a fail drops to box 0. The interval is the step for the box just reached
-- — a lapse uses the first step (1 day). Intervals >= 4 days get ±15% fuzz
-- so a batch reviewed together doesn't all come due on the same future day;
-- shorter steps stay exact.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS record_word_review(TEXT, INT);

CREATE OR REPLACE FUNCTION record_word_review(
  p_headword TEXT,
  p_passed BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_steps        INT[] := ARRAY[1, 3, 7, 14, 30];   -- Leitner ladder (days)
  v_max_box      INT   := array_length(v_steps, 1);  -- 5
  v_cur_box      INT;
  v_new_box      INT;
  v_interval     INT;
  v_fuzz         DOUBLE PRECISION;
BEGIN
  SELECT box INTO v_cur_box
  FROM word_reviews
  WHERE user_id = auth.uid() AND headword = p_headword;
  v_cur_box := COALESCE(v_cur_box, 0);

  IF p_passed THEN
    v_new_box := LEAST(v_cur_box + 1, v_max_box);
  ELSE
    v_new_box := 0;  -- lapse: back to the bottom of the ladder
  END IF;

  -- Interval for the box just reached; a lapse (box 0) uses the first step.
  v_interval := v_steps[GREATEST(v_new_box, 1)];

  v_fuzz := CASE
              WHEN v_interval >= 4 THEN 1 + (random() - 0.5) * 0.3
              ELSE 1
            END;

  INSERT INTO word_reviews (user_id, headword, last_reviewed_at, eligible_at, box)
  VALUES (
    auth.uid(),
    p_headword,
    now(),
    now() + (v_interval * v_fuzz) * INTERVAL '1 day',
    v_new_box
  )
  ON CONFLICT (user_id, headword)
  DO UPDATE SET
    last_reviewed_at = now(),
    eligible_at      = EXCLUDED.eligible_at,
    box              = EXCLUDED.box;
END;
$$;

GRANT EXECUTE ON FUNCTION record_word_review(TEXT, BOOLEAN) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Drop the hide-only RPCs. The Hidden words modal and its Unhide action are
-- removed alongside this migration, so nothing calls these anymore.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_mastered_words();
DROP FUNCTION IF EXISTS clear_word_review(TEXT);
