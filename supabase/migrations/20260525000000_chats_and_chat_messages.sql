-- Chats feature: LLM-driven Japanese conversations. A chat is a thread of
-- alternating user/assistant messages where assistant replies are constrained
-- to the same kanji set + Aozora ruby format as story generation. Each
-- assistant message has a one-time "Mark as Read" toggle that contributes
-- to the user's vocab/kanji encounter totals — analog of the story
-- read_count weighting, but binary (is_read TRUE means +1 per word in the
-- message; FALSE means 0).
--
-- This first migration just lays down the two new tables and their RLS.
-- Later migrations (20260525000100, 20260525000200, 20260525000300) make
-- story_word_occurrences / word_lookups polymorphic so they can also point
-- at chat_messages, then update the read-side aggregation RPCs to UNION
-- both sources.

CREATE TABLE chats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own chats"
  ON chats FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX chats_user_last_activity_idx ON chats (user_id, last_activity_at DESC);

CREATE TABLE chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete', 'failed')),
  error_message TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  word_index_at TIMESTAMPTZ,
  word_index_version INTEGER,
  translations JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own chat messages"
  ON chat_messages FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX chat_messages_chat_created_idx ON chat_messages (chat_id, created_at);
CREATE INDEX chat_messages_user_headword_lookup_idx
  ON chat_messages (user_id, is_read) WHERE role = 'assistant';

-- At most one in-flight assistant message per chat. The Edge Function relies
-- on the resulting 23505 unique-violation to enforce "one pending per chat"
-- rather than racing on a separate count query.
CREATE UNIQUE INDEX chat_messages_pending_unique
  ON chat_messages (chat_id) WHERE status = 'pending' AND role = 'assistant';

COMMENT ON COLUMN chat_messages.content IS
  'Assistant: Aozora ruby kanji《reading》 format. User: plain text.';
COMMENT ON COLUMN chat_messages.is_read IS
  'Per-message read flag. When true, contributes +1 to each indexed word''s encounter count (vs. story read_count which is a multi-read integer).';
COMMENT ON COLUMN chat_messages.translations IS
  'Cache of AI sentence translations, same shape as stories.translations.';
