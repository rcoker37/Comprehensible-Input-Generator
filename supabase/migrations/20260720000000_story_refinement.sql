-- ─────────────────────────────────────────────────────────────────────────
-- Story refinement loop: measure-then-repair comprehensibility.
--
-- After a story is generated, the client measures its word-level
-- comprehensibility (the share of its words that the reader has never seen
-- AND that are rarer than the reader's personal frequency frontier). If too
-- hard, the client calls the `revise-story` Edge Function, which swaps the
-- specific offending words for simpler ones. Up to MAX_PASSES repair passes
-- run, client-orchestrated, until a comprehensibility threshold is cleared.
--
-- Measurement lives on the client (it reuses the existing kuromoji + JMdict +
-- JPDB indexer that already powers the zero-encounter underline), so these
-- columns are pure lifecycle state the browser drives.
--
--   refine_pass       INT   how many repair passes have run (0 = none yet)
--   refine_state      TEXT  NULL      = needs evaluation (fresh, or just revised)
--                           'refining' = a repair pass is in flight
--                           'settled'  = loop done (met threshold / hit pass cap /
--                                        stopped making progress)
--                           'failed'   = a repair pass errored
--   comprehensibility JSONB final measured metrics {fraction, problemCount, pass},
--                           stored when the story settles; drives the
--                           Compositions "≈NN% familiar" badge.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE stories
  ADD COLUMN refine_pass INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN refine_state TEXT
    CHECK (refine_state IN ('refining', 'settled', 'failed')),
  ADD COLUMN comprehensibility JSONB;

-- Existing stories are grandfathered as 'settled' so the loop never
-- retroactively rewrites a user's whole library the first time this ships.
-- Only stories generated from now on (which insert with refine_state = NULL)
-- flow through refinement. learn_word rows stay settled forever regardless —
-- they deliberately teach one rare word and must never be simplified.
UPDATE stories SET refine_state = 'settled';

-- ─────────────────────────────────────────────────────────────────────────
-- Queue for the client-side refinement orchestrator (RefinementContext).
-- A story needs (re-)evaluation exactly when refine_state IS NULL: either
-- freshly generated, or just revised by a repair pass (which resets the
-- state to NULL and bumps refine_pass). 'refining' rows are being handled;
-- 'settled'/'failed' are done. learn_word is excluded — see above.
--
-- No pass cap here: the client owns the cap (and always writes 'settled'
-- when it stops), so a story converges even if this backstop is generous.
-- Content is returned so the scorer can tokenize it without a second fetch,
-- mirroring get_stories_needing_index.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_stories_needing_refinement()
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  refine_pass INTEGER
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT s.id, s.content, s.refine_pass
  FROM stories s
  WHERE s.user_id = auth.uid()
    AND s.status = 'complete'
    AND s.content_type <> 'learn_word'
    AND s.refine_state IS NULL
  ORDER BY s.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_stories_needing_refinement() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Terminal write for the loop: the client calls this when it decides to stop
-- refining a story (threshold met, pass cap reached, or a pass stopped making
-- progress) and stamps the final measured metrics for the badge. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION settle_story_refinement(
  p_story_id BIGINT,
  p_metrics JSONB
)
RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  UPDATE stories
  SET refine_state = 'settled',
      comprehensibility = p_metrics
  WHERE id = p_story_id
    AND user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION settle_story_refinement(BIGINT, JSONB) TO authenticated;
