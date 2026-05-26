-- Make story_word_occurrences and word_lookups polymorphic: each row points
-- at either a story or a chat_message (exactly one). The new nullable
-- chat_message_id column carries the chat-message side; an XOR CHECK
-- (`num_nonnulls = 1`) enforces "exactly one source set".
--
-- The original `UNIQUE (story_id, ...)` constraints are dropped and replaced
-- by two partial UNIQUE indexes — one per source type — since a polymorphic
-- "(this_or_that, offsets)" can't be expressed as a single unique constraint.
--
-- Existing rows are safe because chat_message_id defaults to NULL and every
-- row's story_id is currently non-null: num_nonnulls(NOT_NULL, NULL) = 1,
-- so the CHECK is satisfied immediately. We add the CHECK *before* dropping
-- NOT NULL on story_id so the table is never in a state where the CHECK
-- could fail.

-- ─────────────────────────────────────────────────────────────────────────
-- story_word_occurrences
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE story_word_occurrences
  ADD COLUMN chat_message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE;

ALTER TABLE story_word_occurrences
  ADD CONSTRAINT story_word_occurrences_source_xor
  CHECK (num_nonnulls(story_id, chat_message_id) = 1);

ALTER TABLE story_word_occurrences ALTER COLUMN story_id DROP NOT NULL;

ALTER TABLE story_word_occurrences
  DROP CONSTRAINT story_word_occurrences_story_id_start_offset_end_offset_key;

CREATE UNIQUE INDEX story_word_occurrences_story_uniq
  ON story_word_occurrences (story_id, start_offset, end_offset)
  WHERE story_id IS NOT NULL;

CREATE UNIQUE INDEX story_word_occurrences_chat_msg_uniq
  ON story_word_occurrences (chat_message_id, start_offset, end_offset)
  WHERE chat_message_id IS NOT NULL;

CREATE INDEX story_word_occurrences_chat_msg_headword_idx
  ON story_word_occurrences (user_id, headword)
  WHERE chat_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- word_lookups
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE word_lookups
  ADD COLUMN chat_message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE;

ALTER TABLE word_lookups
  ADD CONSTRAINT word_lookups_source_xor
  CHECK (num_nonnulls(story_id, chat_message_id) = 1);

ALTER TABLE word_lookups ALTER COLUMN story_id DROP NOT NULL;

ALTER TABLE word_lookups
  DROP CONSTRAINT word_lookups_user_id_story_id_start_offset_end_offset_key;

CREATE UNIQUE INDEX word_lookups_story_uniq
  ON word_lookups (user_id, story_id, start_offset, end_offset)
  WHERE story_id IS NOT NULL;

CREATE UNIQUE INDEX word_lookups_chat_msg_uniq
  ON word_lookups (user_id, chat_message_id, start_offset, end_offset)
  WHERE chat_message_id IS NOT NULL;
