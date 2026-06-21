-- Fix: 20260618000000 granted only SELECT to `authenticated` on these three
-- tables, on the theory that all writes flow through RPCs so the role never
-- needs direct DML. But every one of those RPCs — index_story_words,
-- index_chat_message_words, set_story_word_overrides,
-- clear_story_word_overrides, clear_all_story_word_overrides,
-- update_story_content, record_word_lookup, record_word_review,
-- clear_word_review — is SECURITY INVOKER, so it executes the inner
-- DELETE/INSERT/UPDATE with the *caller's* privileges. With only SELECT
-- granted, every such write failed with "permission denied for table ...".
--
-- Most visible symptom: an infinite word-index backfill loop. index_story_words
-- threw on its first `DELETE FROM story_word_occurrences`, before the
-- `UPDATE stories SET word_index_at = ...` stamp, so word_index_at stayed NULL
-- and getStoriesNeedingIndex re-queued every complete story on every pass.
-- record_word_lookup (best-effort, errors swallowed) and record_word_review
-- (fire-and-forget) failed silently for the same reason.
--
-- RLS still scopes every row to auth.uid(), so granting direct DML only lets a
-- user touch their own rows — the same isolation `stories` / `chat_messages`
-- already rely on. SELECT was already granted in 20260618000000; add the
-- missing write privileges. `kanji` is intentionally left SELECT-only (read-only
-- reference data, never written by users).

GRANT INSERT, UPDATE, DELETE ON word_lookups TO authenticated;
GRANT INSERT, UPDATE, DELETE ON story_word_occurrences TO authenticated;
GRANT INSERT, UPDATE, DELETE ON word_reviews TO authenticated;
