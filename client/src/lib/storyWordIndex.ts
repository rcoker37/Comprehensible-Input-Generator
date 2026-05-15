// Walks a story through the same regroup + JMdict pipeline that powers
// StoryDisplay's tap targets, and emits a flat array of every span that
// resolves to a JMdict headword. Used by StoryReadButton to populate the
// `story_word_occurrences` index on first read — see migration
// `20260510400000_story_word_occurrences.sql` for the schema.
//
// Every CharPart is looked up: single-kanji words (「水」「猫」), single-
// kana particles (「が」「を」「に」), and the rest. The lookup itself is
// the filter — JMdict returns no hit for punctuation, whitespace, or
// non-word characters, and those rows are skipped. Indexing particles
// lets the popover surface "N encounters" and the new-word accent
// underline applies to them consistently.
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
import { posHintAtOffset } from "./tokenizer";
import type { Story } from "../types";

export interface WordOccurrence {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string;
  /**
   * JMdict entry id of the `WordResult` the indexer picked for this span.
   * Stored so the popover (and other consumers) can disambiguate between
   * homophone entries reading the same headword string — without it,
   * looking up "ふる" returns 降る/振る/フル/古 in JMdict's natural order
   * and `results[0]` can drift to the wrong entry.
   */
  entryId: number | null;
}

/**
 * Bump whenever the regroup / deinflection / lookup pipeline produces
 * materially different headwords for existing stories. The backfill context
 * treats every story whose stamped `word_index_version` is null or below
 * this constant as out-of-date and re-indexes it.
 *
 * History:
 *   1 — initial. POS-hinted continuative deinflection (なり → なる, etc.)
 *       lands; bump from a null/legacy version forces a full re-index.
 *   2 — pure-kana single-char CharParts (particles like が / を / は, etc.)
 *       are now also indexed so encounter counts and the new-word
 *       underline cover them.
 *   3 — `headwordFromHit` now skips `sK` (search-only) kanji forms, so the
 *       の particle's entry stamps `の` instead of `乃`, and ~80 other
 *       entries whose k[0] is sK now stamp their kana surface as canonical.
 *   4 — `entry_id` is now stamped alongside headword/reading so the popover
 *       can hoist the indexer's chosen JMdict entry instead of guessing
 *       from homophone ordering (fixes いきます → 幾, ふっても → フル).
 */
export const WORD_INDEX_VERSION = 4;

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
          // CharPart — look it up regardless of script. JMdict will return
          // empty for punctuation / whitespace / non-Japanese, which the
          // headwordFromHit guard turns into a skip below.
          start = part.offset;
          end = part.offset + 1;
        }
        const key = `${start}-${end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const posHint = await posHintAtOffset(cleanText, start);
        const hit = await lookupAtBoundary(
          cleanText,
          start,
          end,
          annotations,
          posHint
        );
        if (!hit) continue;
        const headword = headwordFromHit(hit);
        if (!headword) continue;
        occurrences.push({
          start,
          end,
          surface: cleanText.slice(start, end),
          headword: headword.headword,
          reading: headword.reading ?? "",
          entryId: hit.results[0]?.id ?? null,
        });
      }
    }
  }
  return occurrences;
}
