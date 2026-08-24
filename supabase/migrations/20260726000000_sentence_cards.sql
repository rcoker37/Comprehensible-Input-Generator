-- ─────────────────────────────────────────────────────────────────────────
-- Replace the auto-mined word review queue with user-mined SENTENCE CARDS.
--
-- The old Review tab built its queue automatically: every headword with
-- fewer than 10 encounters whose surface carried a still-fragile kanji. The
-- user never chose what to study, and the card was a word shown inside
-- whichever example sentence happened to sort first.
--
-- The new model is classic sentence mining. The reader taps a word in a
-- composition, and the popover's "Add to Reviews" button saves the sentence
-- containing it — together with its furigana and its AI translation — as a
-- review card. Review then drains only what the user deliberately mined.
--
--   front = the sentence, plain Japanese, no ruby at all
--   back  = the same sentence with full furigana + the AI translation
--
-- These are PURE sentence cards: the tapped word is only the entry point
-- for mining and is never marked on either side. That's why no headword /
-- reading / surface span is stored — nothing would read it, and two
-- different words in the same sentence produce the identical card.
--
-- The SRS itself is unchanged: the same Leitner ladder (boxes 0..5, steps
-- 1/3/7/14/30 days, ±15% fuzz past 4 days) that record_word_review walked,
-- now keyed to a card id instead of a headword.
--
-- WHY THE CARD SNAPSHOTS ITS TEXT rather than pointing at (story, offsets):
-- story content is not stable. The refinement loop's revise-story pass
-- rewrites the body, and update_story_content lets the user edit it; both
-- wipe stories.translations and every offset-keyed row. A card holding only
-- offsets would silently rot into the wrong sentence. So the sentence text,
-- its rebased annotations and the translation are all copied onto the card
-- at add time. story_id / chat_message_id are kept for provenance only,
-- ON DELETE SET NULL, so deleting a story leaves its cards intact and
-- reviewable.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE sentence_cards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provenance. At most one is set; both go NULL if the source is deleted.
  story_id BIGINT REFERENCES stories(id) ON DELETE SET NULL,
  chat_message_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,

  -- Char offsets of the sentence in the source's CLEANED (ruby-stripped)
  -- content, as computed by the client's extractSentenceSnippet. Used only
  -- to dedupe re-adds of the same sentence — never to re-derive the text.
  sentence_start INT NOT NULL,
  sentence_end INT NOT NULL,

  -- The snapshot. sentence_text is already ruby-stripped; annotations is a
  -- FuriganaAnnotation[] ({start, end, reading}) rebased to sentence_text.
  sentence_text TEXT NOT NULL,
  annotations JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- The AI translation shown on the back. Non-null: "Add to Reviews"
  -- translates first when the sentence hasn't been translated yet.
  translation TEXT NOT NULL,

  -- Leitner state, same ladder as the old word_reviews.
  box SMALLINT NOT NULL DEFAULT 0,
  last_reviewed_at TIMESTAMPTZ,
  eligible_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sentence_cards_source_at_most_one
    CHECK (num_nonnulls(story_id, chat_message_id) <= 1)
);

-- One card per sentence per source. A second tap on a different word in an
-- already-mined sentence is a no-op rather than a near-duplicate card.
-- Partial so orphaned cards (source deleted → both ids NULL) never collide.
CREATE UNIQUE INDEX sentence_cards_story_sentence_uniq
  ON sentence_cards (user_id, story_id, sentence_start, sentence_end)
  WHERE story_id IS NOT NULL;

CREATE UNIQUE INDEX sentence_cards_chat_sentence_uniq
  ON sentence_cards (user_id, chat_message_id, sentence_start, sentence_end)
  WHERE chat_message_id IS NOT NULL;

-- Drives the due-queue scan.
CREATE INDEX sentence_cards_user_eligible_idx
  ON sentence_cards (user_id, eligible_at);

ALTER TABLE sentence_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own sentence cards"
  ON sentence_cards FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Every RPC below is SECURITY INVOKER, so the inner DML runs with the
-- caller's privileges and needs an explicit table-level grant on top of the
-- RLS policy (see 20260621000000_grant_authenticated_dml_on_rpc_tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON sentence_cards TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- add_sentence_card — called by the WordPopover's "Add to Reviews" button.
--
-- Idempotent per sentence: re-adding an already-mined sentence returns the
-- existing card untouched (its Leitner progress is NOT reset). The client
-- normally never reaches that path — SentenceCardsContext already knows the
-- sentence is mined and disables the button — but two tabs can race, so the
-- server stays the source of truth.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_sentence_card(
  p_story_id BIGINT,
  p_chat_message_id BIGINT,
  p_sentence_start INT,
  p_sentence_end INT,
  p_sentence_text TEXT,
  p_annotations JSONB,
  p_translation TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  BIGINT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF num_nonnulls(p_story_id, p_chat_message_id) <> 1 THEN
    RAISE EXCEPTION 'Exactly one of story_id / chat_message_id must be set';
  END IF;

  -- Return the existing card if this sentence is already mined. Done as an
  -- explicit lookup rather than ON CONFLICT because the uniqueness lives in
  -- two partial indexes and ON CONFLICT can't target both in one statement.
  SELECT id INTO v_id
  FROM sentence_cards
  WHERE user_id = v_uid
    AND sentence_start = p_sentence_start
    AND sentence_end = p_sentence_end
    AND story_id IS NOT DISTINCT FROM p_story_id
    AND chat_message_id IS NOT DISTINCT FROM p_chat_message_id;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO sentence_cards (
    user_id, story_id, chat_message_id,
    sentence_start, sentence_end,
    sentence_text, annotations, translation
  )
  VALUES (
    v_uid, p_story_id, p_chat_message_id,
    p_sentence_start, p_sentence_end,
    p_sentence_text, COALESCE(p_annotations, '[]'::JSONB), p_translation
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION add_sentence_card(
  BIGINT, BIGINT, INT, INT, TEXT, JSONB, TEXT
) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_sentence_card_queue — the cards due right now, oldest-due first.
--
-- Unlike the old word queue there is nothing to sort client-side: the cards
-- are user-chosen, so JPDB rank ordering no longer applies and the queue can
-- be fully ordered in SQL. The source ids + sentence offsets ride along so
-- the client can rebuild a card's SentenceCardsContext key when deleting it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_sentence_card_queue()
RETURNS TABLE (
  id BIGINT,
  story_id BIGINT,
  chat_message_id BIGINT,
  sentence_start INT,
  sentence_end INT,
  sentence_text TEXT,
  annotations JSONB,
  translation TEXT,
  box SMALLINT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    c.id, c.story_id, c.chat_message_id,
    c.sentence_start, c.sentence_end,
    c.sentence_text, c.annotations, c.translation,
    c.box, c.created_at
  FROM sentence_cards c
  WHERE c.user_id = auth.uid()
    AND c.eligible_at <= now()
  ORDER BY c.eligible_at ASC, c.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION get_sentence_card_queue() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_sentence_card_keys — the identity of EVERY card (not just the due
-- ones), so the WordPopover can tell whether the sentence under the tapped
-- word is already mined without a round-trip per popover open.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_sentence_card_keys()
RETURNS TABLE (
  story_id BIGINT,
  chat_message_id BIGINT,
  sentence_start INT,
  sentence_end INT
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.story_id, c.chat_message_id, c.sentence_start, c.sentence_end
  FROM sentence_cards c
  WHERE c.user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION get_sentence_card_keys() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- record_sentence_card_review(card, passed): Leitner state transition.
--
-- Lifted from record_word_review (20260616000000) except that it UPDATEs an
-- existing card instead of upserting by headword. STEPS is the per-box
-- interval in days; a pass climbs one box (capped at 5), a fail drops to
-- box 0. Intervals >= 4 days get ±15% fuzz so a batch mined and reviewed
-- together doesn't all come due on the same future day.
--
-- Note v_steps is 1-indexed while box is 0-indexed, so boxes 0 and 1 both
-- map to the 1-day step — a lapse is due tomorrow, never later today.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_sentence_card_review(
  p_card_id BIGINT,
  p_passed BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_steps    INT[] := ARRAY[1, 3, 7, 14, 30];   -- Leitner ladder (days)
  v_max_box  INT   := array_length(v_steps, 1);  -- 5
  v_cur_box  INT;
  v_new_box  INT;
  v_interval INT;
  v_fuzz     DOUBLE PRECISION;
BEGIN
  SELECT box INTO v_cur_box
  FROM sentence_cards
  WHERE id = p_card_id AND user_id = auth.uid();

  IF v_cur_box IS NULL THEN
    RETURN;  -- card deleted in another tab; nothing to stamp
  END IF;

  IF p_passed THEN
    v_new_box := LEAST(v_cur_box + 1, v_max_box);
  ELSE
    v_new_box := 0;  -- lapse: back to the bottom of the ladder
  END IF;

  v_interval := v_steps[GREATEST(v_new_box, 1)];

  v_fuzz := CASE
              WHEN v_interval >= 4 THEN 1 + (random() - 0.5) * 0.3
              ELSE 1
            END;

  UPDATE sentence_cards
  SET last_reviewed_at = now(),
      eligible_at      = now() + (v_interval * v_fuzz) * INTERVAL '1 day',
      box              = v_new_box
  WHERE id = p_card_id AND user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION record_sentence_card_review(BIGINT, BOOLEAN) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- delete_sentence_card — the per-card delete button on the Review page.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_sentence_card(p_card_id BIGINT)
RETURNS VOID
LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  DELETE FROM sentence_cards
  WHERE id = p_card_id AND user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION delete_sentence_card(BIGINT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Retire the auto-mined word queue it replaces.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_review_queue();
DROP FUNCTION IF EXISTS record_word_review(TEXT, BOOLEAN);
DROP TABLE IF EXISTS word_reviews;
