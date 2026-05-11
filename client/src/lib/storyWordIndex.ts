// Walks a story through the same regroup + JMdict pipeline that powers
// StoryDisplay's tap targets, and emits a flat array of every span that
// resolves to a JMdict headword. Used by StoryReadButton to populate the
// `story_word_occurrences` index on first read — see migration
// `20260510400000_story_word_occurrences.sql` for the schema.
//
// Single-kanji CharParts are looked up (they're standalone kanji words like
// 「水」「猫」 that regroupWords couldn't merge into anything longer). Pure
// hiragana / katakana CharParts are skipped — they're particles, fillers,
// or characters that didn't merge, none of which produce useful headwords
// the user would want to revisit.
//
// The work is duplicated from StoryDisplay's regroup pass; the kuromoji
// tokenizer and JMdict IDB are both cached, so the dominant cost is the
// per-part dictionary lookup. A typical 5-paragraph story produces a few
// hundred lookups — fast enough to run in the background after the user
// clicks Read.
import { getDictionaryState } from "./dictionary";
import { headwordFromHit } from "./headword";
import { lookupAtBoundary } from "./lookupAtCursor";
import { parseAnnotatedText } from "./furigana";
import { regroupWords } from "./regroupWords";
import { buildDisplaySegments } from "./storySegments";
import { stripBold } from "./text";
import { KANJI_REGEX } from "./constants";
import type { Story } from "../types";

export interface WordOccurrence {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string;
}

export class DictionaryNotReadyError extends Error {
  constructor() {
    super("Dictionary not ready");
    this.name = "DictionaryNotReadyError";
  }
}

export async function extractWordOccurrences(
  story: Pick<Story, "content">
): Promise<WordOccurrence[]> {
  // Without the dictionary, every lookup would return [] and we'd stamp the
  // story as "indexed" with zero rows — locking it out of the retry path.
  // Bail loudly so StoryReadButton can swallow the error and let the next
  // mark-as-read try again.
  if (getDictionaryState() !== "ready") {
    throw new DictionaryNotReadyError();
  }

  const raw = stripBold(story.content);
  const { cleanText, annotations } = parseAnnotatedText(raw);
  const base = buildDisplaySegments(cleanText, annotations);
  const regrouped = await regroupWords(base, cleanText, annotations);

  const occurrences: WordOccurrence[] = [];
  const seen = new Set<string>();

  for (const para of regrouped) {
    for (const sent of para.sentences) {
      for (const part of sent.parts) {
        let start: number;
        let end: number;
        if (part.kind === "annotated") {
          start = part.start;
          end = part.end;
        } else if (part.kind === "word") {
          start = part.start;
          end = part.end;
        } else {
          // CharPart — only worth a lookup when it's a standalone kanji.
          if (!KANJI_REGEX.test(part.char)) continue;
          start = part.offset;
          end = part.offset + 1;
        }
        const key = `${start}-${end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const hit = await lookupAtBoundary(cleanText, start, end, annotations);
        if (!hit) continue;
        const headword = headwordFromHit(hit);
        if (!headword) continue;
        occurrences.push({
          start,
          end,
          surface: cleanText.slice(start, end),
          headword: headword.headword,
          reading: headword.reading ?? "",
        });
      }
    }
  }
  return occurrences;
}
