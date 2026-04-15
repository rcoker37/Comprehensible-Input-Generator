-- One-shot backfill: strip markdown artifacts (#, -, *, +, >, **, __) from
-- existing story titles and content. New stories get cleaned at save time by
-- cleanGeneratedText() in client/src/lib/text.ts, so this is purely a
-- retrofit for rows saved before that helper existed.
--
-- If the text actually changed, clear stories.audio so the next playback
-- regenerates TTS from the cleaned input (old timings were computed against
-- the un-stripped text and won't line up).

-- Helper: mirror of cleanGeneratedText from client/src/lib/text.ts.
-- Dropped at the end of this migration; exists only for this backfill.
CREATE OR REPLACE FUNCTION clean_generated_text(input TEXT) RETURNS TEXT AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(input, '^\s*#{1,6}\s+', '', 'gn'),
                 '^\s*[-*+]\s+', '', 'gn'),
               '^\s*>\s+', '', 'gn'),
             '\*\*', '', 'g'),
           '__', '', 'g')
$$ LANGUAGE sql IMMUTABLE;

WITH updates AS (
  SELECT
    id,
    clean_generated_text(title)   AS new_title,
    clean_generated_text(content) AS new_content
  FROM stories
)
UPDATE stories s
SET
  title   = u.new_title,
  content = u.new_content,
  audio   = CASE
              WHEN s.title <> u.new_title OR s.content <> u.new_content THEN NULL
              ELSE s.audio
            END
FROM updates u
WHERE s.id = u.id
  AND (s.title <> u.new_title OR s.content <> u.new_content);

DROP FUNCTION clean_generated_text(TEXT);
