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
import { parseAnnotatedText, type FuriganaAnnotation } from "./furigana";
import { regroupWords } from "./regroupWords";
import { buildDisplaySegments, type AnnotatedPart } from "./storySegments";
import { stripBold } from "./text";
import { posHintAtOffset, tokenizeText, type KuromojiTokenInfo } from "./tokenizer";
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
 *  10 — the rare-merge veto now also covers JMdict `exp` *expression* entries
 *       (`hitIsExpression` in regroupWords.ts), exact or deinflected. A
 *       kuromoji-split merge into a noun + particle + verb phrase JPDB has
 *       never ranked is refused: 雨が降り stays 雨 / が / 降り and 家を出て
 *       stays 家 / を / 出て, while JPDB-ranked expressions (青くなる, 木の葉)
 *       still merge. This is the kanji-bearing case the kana-only veto skipped.
 *  11 — two POS-hinted deinflection fixes in lookupAtCursor.ts. (a) When the
 *       LLM furigana don't disambiguate a kuromoji-動詞 span, the verb branch
 *       now picks the most common lemma by JPDB rank instead of `deinflect`'s
 *       priority order (`pickVerbDeinflection`): なって resolves to the everyday
 *       なる, not the rare 綯う. (b) The verb branch also runs when the exact
 *       match is only unranked `exp` expression entries (`exactIsUnrankedExpression`),
 *       so 見られる resolves to the verb 見る instead of the unranked honorific
 *       phrase entry — which also lets the regroup pass merge the whole span.
 *  12 — two more fixes. (a) lookupAtBoundary now arbitrates *every* pure-kana
 *       exact match against its deinflection by JPDB rank — not just kanji-
 *       canonical ones — and a short suffix-swap deinflection (consumed 1, no
 *       lengthening) is no longer suppressed, so により resolves to the common
 *       による (rank 200) instead of the rare uk entry に因り (rank 22,986).
 *       (b) extractWordOccurrences sub-segments a multi-kanji annotated block
 *       with no whole-span JMdict entry (普通選挙法) at kuromoji boundaries,
 *       indexing 普通 / 選挙 / 法 — but only when the pieces' readings
 *       reconstruct the LLM ruby, so 山手線 (やまのてせん) stays unindexed.
 */
export const WORD_INDEX_VERSION = 12;

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
  const tokens = await tokenizeText(cleanText);

  const occurrences: WordOccurrence[] = [];
  const seen = new Set<string>();
  const emit = (occ: WordOccurrence): void => {
    const key = `${occ.start}-${occ.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push(occ);
  };

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
          // empty for punctuation / whitespace / non-Japanese, which
          // lookupSpanOccurrence turns into a skip.
          start = part.offset;
          end = part.offset + 1;
        }
        if (seen.has(`${start}-${end}`)) continue;

        const occ = await lookupSpanOccurrence(
          cleanText,
          start,
          end,
          annotations
        );
        if (occ) {
          emit(occ);
          continue;
        }
        // No whole-span entry. A multi-kanji annotated block the LLM wrote as
        // one ruby unit (普通選挙法) can still be sub-segmented at kuromoji
        // boundaries — index the pieces JMdict does know.
        if (part.kind === "annotated") {
          for (const sub of await subSegmentAnnotated(
            part,
            cleanText,
            annotations,
            tokens
          )) {
            emit(sub);
          }
        }
      }
    }
  }
  return occurrences;
}

/**
 * Resolve one span to a `WordOccurrence`, or null when it has no usable JMdict
 * headword (punctuation, whitespace, a no-match fallback). The per-part lookup
 * shared by the main loop and `subSegmentAnnotated`.
 */
async function lookupSpanOccurrence(
  cleanText: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[]
): Promise<WordOccurrence | null> {
  const posHint = await posHintAtOffset(cleanText, start);
  const hit = await lookupAtBoundary(cleanText, start, end, annotations, posHint);
  if (!hit) return null;
  const headword = headwordFromHit(hit);
  if (!headword) return null;
  return {
    start,
    end,
    surface: cleanText.slice(start, end),
    headword: headword.headword,
    reading: headword.reading ?? "",
    entryId: hit.results[0]?.id ?? null,
  };
}

/**
 * Sub-segment a multi-kanji annotated block the LLM wrote as one ruby unit but
 * JMdict has no whole-span entry for. kuromoji already splits 普通選挙法 into
 * 普通 / 選挙 / 法 (all JMdict words); this tiles the block with those tokens
 * and indexes each piece.
 *
 * The split is trusted only when the pieces' stamped readings concatenate back
 * to the LLM's ruby for the whole block. That guards against proper nouns and
 * 熟字訓 whose block reading isn't compositional: 山手線《やまのてせん》 tiles
 * into 山手 (stamped やまて) + 線 (せん) → やまてせん ≠ やまのてせん, so it is
 * left unindexed rather than mis-split. Returns [] (no sub-spans) on any miss.
 */
async function subSegmentAnnotated(
  part: AnnotatedPart,
  cleanText: string,
  annotations: FuriganaAnnotation[],
  tokens: KuromojiTokenInfo[]
): Promise<WordOccurrence[]> {
  // The kuromoji tokens must tile [part.start, part.end) exactly: ≥2 of them,
  // contiguous, no overhang. Anything else and we don't trust the split.
  const inside = tokens.filter(
    (t) => t.start >= part.start && t.end <= part.end
  );
  if (inside.length < 2) return [];
  let cursor = part.start;
  for (const t of inside) {
    if (t.start !== cursor) return [];
    cursor = t.end;
  }
  if (cursor !== part.end) return [];

  const pieces: WordOccurrence[] = [];
  let reading = "";
  for (const t of inside) {
    const piece = await lookupSpanOccurrence(
      cleanText,
      t.start,
      t.end,
      annotations
    );
    if (!piece) return [];
    pieces.push(piece);
    reading += piece.reading;
  }
  return reading === part.reading ? pieces : [];
}
