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
 * The algorithm version stamped onto `stories.word_index_version` every time
 * the indexer runs. It is a provenance record — *which* generation of the
 * regroup / deinflection / lookup pipeline produced a story's index — not a
 * re-index trigger.
 *
 * Bumping this constant does NOT auto-re-index existing stories. The backfill
 * only picks up stories whose `word_index_at` is null (never indexed, or
 * explicitly cleared by a content edit / override save / override reset). To
 * re-index already-stamped stories after a pipeline change, ship a one-off
 * migration that nulls `word_index_at` for the rows you want rebuilt — e.g.
 * `UPDATE stories SET word_index_at = NULL WHERE word_index_version < 6`.
 *
 * Still worth bumping on every materially-different pipeline change so the
 * stamp stays accurate and such a migration has a clean predicate to target.
 *
 * History:
 *   1 — initial. POS-hinted continuative deinflection (なり → なる, etc.).
 *   2 — pure-kana single-char CharParts (particles like が / を / は, etc.)
 *       are now also indexed so encounter counts and the new-word
 *       underline cover them.
 *   3 — `headwordFromHit` now skips `sK` (search-only) kanji forms, so the
 *       の particle's entry stamps `の` instead of `乃`, and ~80 other
 *       entries whose k[0] is sK now stamp their kana surface as canonical.
 *   4 — `entry_id` is now stamped alongside headword/reading so the popover
 *       can hoist the indexer's chosen JMdict entry instead of guessing
 *       from homophone ordering (fixes いきます → 幾, ふっても → フル).
 *   5 — dictionary lookups now prefer a script-exact match over a
 *       hiragana/katakana-folded one, so the hiragana conjunction でも no
 *       longer stamps the katakana loanword デモ (and similar kana pairs).
 *   6 — two lookup-pipeline fixes. (a) A pure-kana surface whose only exact
 *       match is a kanji-canonical entry is arbitrated against its best
 *       deinflection by JPDB frequency (`exactRankWins` in lookupAtCursor.ts):
 *       the common 乗せる is kept for 「のせる」 instead of the rare potential-
 *       form lemma 伸す, while a rare exact match still yields to a common
 *       deinflection (いきたい → 行く). (b) The regroup pass refuses a merge the
 *       LLM furigana contradict (`annotationContradictsHit`), so 今日《きょう》は
 *       is no longer swallowed into the greeting こんにちは.
 *   7 — the regroup pass refuses to merge a kuromoji-split span into a JMdict
 *       entry JPDB has never ranked as a word: で|は stays split instead of
 *       collapsing into the unranked では expression, これ|は instead of これは.
 *       Lexicalised compound particles JPDB does rank (には, とは) still merge.
 *   8 — that rare-merge veto is now kana-aware (`rareKanaMergeProbe` in
 *       regroupWords.ts). It fires only when the merged surface is kana-only
 *       AND JPDB ranks it no better than the very-rare tier (or not at all);
 *       a kanji-bearing surface is never vetoed. Fixes two regressions:
 *       高《たか》さ now merges into 高さ (JPDB has no 高さ entry, so the old
 *       unranked-only veto wrongly blocked the merge), and さ|は no longer
 *       collapses into the rare word 左派 (rank 62,243).
 *   9 — the rare-merge veto now has a deinflection counterpart
 *       (`deinflectionMergeStartsOnParticle` in regroupWords.ts). A merge is
 *       refused when it deinflects across a kuromoji boundary and kuromoji
 *       tagged its leading token as a particle: は|もう no longer collapses
 *       into the volitional of the rare verb 食む (はむ, rank 25,527 — inside
 *       the `rare` tier, so the kana-rank veto couldn't catch it).
 */
export const WORD_INDEX_VERSION = 9;

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
