-- The grammar-level filter has been removed from the Generator UI;
-- the column is no longer read or written by the client.

ALTER TABLE profiles DROP COLUMN preferred_grammar_level;
