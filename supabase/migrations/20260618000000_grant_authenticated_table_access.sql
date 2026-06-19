-- Newer Supabase CLI versions no longer auto-grant table privileges to
-- authenticated/anon roles on db reset. Add explicit grants so RLS policies
-- can actually fire (table-level grant is checked before row-level policy).

-- kanji is read-only reference data; anon has no RLS policy so keep it authenticated-only
GRANT SELECT ON kanji TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_kanji TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON stories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON chats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO authenticated;

-- These tables are written exclusively through RPCs; direct DML would bypass
-- dedup logic (word_lookups), cooldown enforcement (word_reviews), and index
-- integrity (story_word_occurrences).
GRANT SELECT ON word_lookups TO authenticated;
GRANT SELECT ON story_word_occurrences TO authenticated;
GRANT SELECT ON word_reviews TO authenticated;
