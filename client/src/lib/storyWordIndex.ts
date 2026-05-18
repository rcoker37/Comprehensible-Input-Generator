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
import { loadFrequencyIndex, lookupFrequencySync } from "./frequency";
import { headwordFromHit } from "./headword";
import { lookupAtBoundary } from "./lookupAtCursor";
import { parseAnnotatedText, type FuriganaAnnotation } from "./furigana";
import { regroupWords } from "./regroupWords";
import { buildDisplaySegments, type AnnotatedPart } from "./storySegments";
import { stripBold } from "./text";
import {
  isProperNoun,
  posHintAtOffset,
  tokenizeText,
  type KuromojiTokenInfo,
} from "./tokenizer";
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
  /**
   * True when the span is a proper noun (place / person / organisation). The
   * popover renders a "Name" header and skips the JMdict lookup. Set only by
   * `subSegmentAnnotated` for a kuromoji-tagged 固有名詞 piece of a
   * sub-segmented ruby block; every other emit path is a regular word.
   */
  isName: boolean;
}

/**
 * The algorithm version stamped onto `stories.word_index_version` every time
 * the indexer runs — *which* generation of the regroup / deinflection /
 * lookup pipeline produced a story's index.
 *
 * Bumping this constant DOES re-index every already-stamped story: the
 * backfill query (`getStoriesNeedingIndex`) picks up any complete story whose
 * `word_index_version` is null or below this constant, alongside the ones
 * whose `word_index_at` is null (never indexed, or cleared by a content edit /
 * override save / override reset). A re-index re-stamps the version, so each
 * story drops out of the query once it catches up — no migration needed.
 *
 * So bump this on every materially-different pipeline change; the whole
 * library re-indexes itself on the next backfill pass.
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
 *  13 — numbered words are handled by `regroupNumberSpans`. JMdict has whole-
 *       span entries for a few common number+counter combos (五月, 二十二日)
 *       but not the long tail (一九二五年, 十四年, 二年前). A numeral-led run is
 *       found whether the LLM wrote it as one annotated block or as per-
 *       character rubies (一/九/二/五/年). A run JPDB ranks as a word stays a
 *       single merged span keyed on its surface (so vocab scoring captures
 *       the rank); an unranked run is split — the numeral run becomes one
 *       span and each trailing counter/suffix character is peeled off as its
 *       own span, its reading recovered from the LLM ruby right-to-left so
 *       the counter (年, 前, …) is indexed and scored on its own. A multi-
 *       char occurrence that already carries an entry id (二十五 → ２５) is
 *       left intact rather than absorbed.
 *  14 — the kuromoji POS hint now routes through `verbHintAt` (tokenizer.ts):
 *       a 連用形 noun (終わり, 始め, 動き) immediately followed by the copula
 *       (だ / です) keeps its noun reading instead of being deinflected to the
 *       verb, so 物語の終わりだった indexes 終わり as the noun, not 終わる. The
 *       regroup pass also no longer treats a 動詞→copula boundary as an
 *       aux-orphaning boundary, so 終わり merges into one span instead of
 *       splitting into 終 / わ / り.
 *  15 — two expression-merge fixes. (a) The kuromoji-split merge veto no longer
 *       fires when the span is one content word + its auxiliary chain
 *       (いらっしゃい+ませ), so a fixed `exp` greeting JMdict double-lists no
 *       longer shatters into single kana. (b) `lookupAtBoundary` now prefers a
 *       verb deinflection over an exact match that is only unranked `exp`
 *       entries regardless of the kuromoji POS hint, so 心をこめて resolves to
 *       the JPDB-ranked 心を込める and merges the full span.
 *  16 — `subSegmentAnnotated` now partitions the LLM ruby across the kuromoji
 *       pieces using *every* reading JMdict lists for each piece's entry, not
 *       just the piece's default reading. 山手線《やまのてせん》 splits into
 *       山手 (やまのて) + 線 (せん) — the compositional reading exists, the old
 *       default-reading check (山手 → やまて) missed it. A genuinely non-
 *       compositional 熟字訓 (五月雨《さみだれ》, kept whole by kuromoji anyway)
 *       still has no valid partition and stays unindexed.
 *  17 — `subSegmentAnnotated` now flags a sub-segment piece kuromoji tags
 *       固有名詞 (proper noun) as a name (`isName=true`, `entryId=null`,
 *       surface as headword): 山手 inside 山手線《やまのてせん》 indexes as a
 *       name, so the popover shows a "Name" header instead of the unrelated
 *       common noun 山手「hilly uptown district」. Only pieces of a
 *       sub-segmented block are affected — a standalone proper noun (東京) is
 *       still indexed as its JMdict word.
 */
export const WORD_INDEX_VERSION = 17;

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

  // Numbered-word handling consults JPDB ranks; load the index up front so
  // the post-pass can decide merge-vs-split synchronously. A load failure is
  // non-fatal — `regroupNumberSpans` then treats every run as unranked.
  let freqReady = true;
  try {
    await loadFrequencyIndex();
  } catch {
    freqReady = false;
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
        // No whole-span entry.
        if (part.kind === "annotated") {
          // A multi-character annotated block the LLM wrote starting with a
          // numeral is a "numbered word" (一九二五年, 十四年, 二年前). JMdict
          // rarely has a whole-span entry for these — emit it whole here and
          // let `regroupNumberSpans` decide whether to keep it merged (JPDB
          // ranks it) or split the numeral run from its counter.
          if (end - start >= 2 && isNumeralChar(cleanText[start] ?? "")) {
            emit({
              start,
              end,
              surface: cleanText.slice(start, end),
              headword: cleanText.slice(start, end),
              reading: part.reading,
              entryId: null,
              isName: false,
            });
            continue;
          }
          // A multi-kanji annotated block the LLM wrote as one ruby unit
          // (普通選挙法) can still be sub-segmented at kuromoji boundaries —
          // index the pieces JMdict does know.
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
  return regroupNumberSpans(occurrences, cleanText, annotations, freqReady);
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
    isName: false,
  };
}

/** Fold a katakana run to hiragana so a kuromoji reading (ヤマテ) can serve as
 *  a partition candidate alongside JMdict's hiragana readings. */
function kataToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out +=
      c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

/**
 * Sub-segment a multi-kanji annotated block the LLM wrote as one ruby unit but
 * JMdict has no whole-span entry for. kuromoji already splits 普通選挙法 into
 * 普通 / 選挙 / 法 (all JMdict words); this tiles the block with those tokens
 * and indexes each piece.
 *
 * A piece kuromoji tags 固有名詞 (proper noun) is emitted as a *name* — surface
 * as headword, `entryId=null`, `isName=true` — so the popover shows a "Name"
 * header rather than the unrelated common-noun JMdict entry (山手 inside
 * 山手線《やまのてせん》 is the railway-line name, not the noun「hilly uptown
 * district」). A non-name piece must resolve to a JMdict headword or the whole
 * split is rejected.
 *
 * The split is trusted only when some assignment of candidate readings to the
 * pieces reconstructs the LLM's ruby for the whole block — every reading JMdict
 * lists for a piece's entry plus the kuromoji reading is tried, not just the
 * piece's default. That lets 山手線《やまのてせん》 split into 山手 (やまのて) +
 * 線 (せん) even though 山手's default reading is the commoner やまて, while a
 * non-compositional 熟字訓 like 五月雨《さみだれ》 has no valid partition and is
 * left unindexed. Each piece is stamped with the reading the partition assigned
 * it. Returns [] (no sub-spans) on any miss.
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

  // Resolve each kuromoji token, collecting every candidate reading so the
  // block ruby can be partitioned compositionally even when a piece's reading
  // isn't its commonest one. A 固有名詞 token becomes a name occurrence; any
  // other token must resolve to a JMdict headword.
  const pieces: { occ: WordOccurrence; readings: string[] }[] = [];
  for (const t of inside) {
    const posHint = await posHintAtOffset(cleanText, t.start);
    const hit = await lookupAtBoundary(
      cleanText,
      t.start,
      t.end,
      annotations,
      posHint
    );
    const headword = hit ? headwordFromHit(hit) : null;
    const readings = new Set<string>();
    readings.add(kataToHira(t.surface));
    if (headword?.reading) readings.add(headword.reading);
    for (const wr of hit?.results ?? []) {
      for (const r of wr.r ?? []) readings.add(r.ent);
    }
    const surface = cleanText.slice(t.start, t.end);
    let occ: WordOccurrence;
    if (isProperNoun(t)) {
      occ = {
        start: t.start,
        end: t.end,
        surface,
        headword: surface,
        reading: "",
        entryId: null,
        isName: true,
      };
    } else if (hit && headword) {
      occ = {
        start: t.start,
        end: t.end,
        surface,
        headword: headword.headword,
        reading: headword.reading ?? "",
        entryId: hit.results[0]?.id ?? null,
        isName: false,
      };
    } else {
      // A non-name piece JMdict can't resolve — don't trust the split.
      return [];
    }
    pieces.push({ occ, readings: [...readings] });
  }

  const assigned = partitionReading(
    part.reading,
    pieces.map((p) => p.readings)
  );
  if (!assigned) return [];
  return pieces.map((p, i) => ({ ...p.occ, reading: assigned[i]! }));
}

/**
 * Assign one candidate reading to each piece so the concatenation equals
 * `target`, returning the chosen readings in piece order — or null when no
 * assignment works. Backtracks, so a piece reading that prefixes the next
 * piece's correct reading doesn't dead-end the search. Pure; exported for unit
 * tests.
 */
export function partitionReading(
  target: string,
  candidates: string[][]
): string[] | null {
  const solve = (pos: number, idx: number): string[] | null => {
    if (idx === candidates.length) {
      return pos === target.length ? [] : null;
    }
    for (const c of candidates[idx]!) {
      if (c.length === 0 || !target.startsWith(c, pos)) continue;
      const rest = solve(pos + c.length, idx + 1);
      if (rest) return [c, ...rest];
    }
    return null;
  };
  return solve(0, 0);
}

// ---------------------------------------------------------------------------
// Numbered-word handling
//
// JMdict carries whole-span entries for a handful of common number+counter
// combos (五月 → ５月, 二十二日 → ２２日) but not the long tail (一九二五年,
// 十四年, 二年前). Left to the per-character pipeline those become a dead tap
// target or a string of meaningless per-digit spans. `regroupNumberSpans`
// instead collects each numeral-led run — whether the LLM wrote it as one
// annotated block or as per-character rubies — and either keeps it merged
// (JPDB ranks the combo as a word) or splits the numeral run from its
// trailing counter (it does not).
// ---------------------------------------------------------------------------

const NUMERAL_CHARS = new Set(
  "〇一二三四五六七八九十百千万億兆0123456789０１２３４５６７８９"
);

// Common counter kanji. Used to recognise an all-numeral/counter occurrence
// as a number fragment; a numeral-led occurrence with no JMdict entry is also
// treated as a fragment, so this set need not be exhaustive.
const COUNTER_CHARS = new Set(
  "年月日時分秒円才歳人名回度個本冊枚台匹頭羽階番号周件票杯軒着足歩点語字句行巻通発丁"
);

function isNumeralChar(ch: string): boolean {
  return NUMERAL_CHARS.has(ch);
}

/**
 * True when every character is a numeral or a counter. Exported for unit
 * testing alongside {@link longestReadingSuffix}.
 */
export function isNumberFragment(surface: string): boolean {
  if (surface.length === 0) return false;
  for (const ch of surface) {
    if (!NUMERAL_CHARS.has(ch) && !COUNTER_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * The longest candidate reading that `reading` ends with — used to peel a
 * trailing counter's reading off a fused number+counter ruby (にねん → 年's
 * ねん). Pure; exported for unit tests.
 */
export function longestReadingSuffix(
  reading: string,
  candidates: string[]
): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (c.length === 0 || !reading.endsWith(c)) continue;
    if (!best || c.length > best.length) best = c;
  }
  return best;
}

/** A numeral-led / all-numeral-counter occurrence — a candidate run member. */
function isNumberAtom(o: WordOccurrence): boolean {
  if (o.surface.length === 0) return false;
  if (isNumberFragment(o.surface)) return true;
  // A numeral-led occurrence with no JMdict entry — e.g. a merged block like
  // 二年前 whose remainder (年前) isn't purely counters.
  return NUMERAL_CHARS.has(o.surface[0]!) && o.entryId === null;
}

/**
 * Absorbable into a number run. A multi-character occurrence that already
 * carries a JMdict entry id (二十五 → ２５) is excluded — it is a recognised,
 * JPDB-rankable word on its own and must not be swallowed into a longer run.
 */
function isNumberRunMember(o: WordOccurrence): boolean {
  return isNumberAtom(o) && (o.end - o.start === 1 || o.entryId === null);
}

/**
 * Split an unranked numeral run into its numeral span plus one span per
 * trailing counter / suffix character. Each trailing character's reading is
 * peeled off the run's ruby right-to-left (にねんまえ → 前 まえ → 年 ねん),
 * leaving the prefix as the numeral run's reading. Falls back to a single
 * merged span if the peel can't be reconciled with the ruby.
 */
async function splitNumberRun(
  runStart: number,
  runEnd: number,
  surface: string,
  reading: string,
  cleanText: string
): Promise<WordOccurrence[]> {
  const merged: WordOccurrence = {
    start: runStart,
    end: runEnd,
    surface,
    headword: surface,
    reading,
    entryId: null,
    isName: false,
  };
  // Leading maximal numeral run.
  let ns = runStart;
  while (ns < runEnd && NUMERAL_CHARS.has(cleanText[ns]!)) ns++;
  // A pure number (no counter) — nothing to peel.
  if (ns >= runEnd) return [merged];

  const tail: WordOccurrence[] = [];
  let rem = reading;
  for (let pos = runEnd - 1; pos >= ns; pos--) {
    const hit = await lookupAtBoundary(cleanText, pos, pos + 1, []);
    const hw = hit ? headwordFromHit(hit) : null;
    if (!hit || !hw) return [merged];
    const readings = hit.results.flatMap((wr) => wr.r?.map((r) => r.ent) ?? []);
    const match = longestReadingSuffix(rem, readings);
    if (!match) return [merged];
    rem = rem.slice(0, rem.length - match.length);
    tail.unshift({
      start: pos,
      end: pos + 1,
      surface: cleanText[pos]!,
      headword: hw.headword,
      reading: match,
      entryId: hit.results[0]?.id ?? null,
      isName: false,
    });
  }
  // The numeral run must keep a non-empty reading of its own.
  if (rem.length === 0) return [merged];
  const numeralSurface = cleanText.slice(runStart, ns);
  return [
    {
      start: runStart,
      end: ns,
      surface: numeralSurface,
      headword: numeralSurface,
      reading: rem,
      entryId: null,
      isName: false,
    },
    ...tail,
  ];
}

/**
 * Collect every numeral-led run in `occurrences` and re-emit it: a run JPDB
 * ranks as a word stays one merged span (so vocab scoring weights it); an
 * unranked run is split via {@link splitNumberRun}. Non-number occurrences
 * pass through untouched.
 */
async function regroupNumberSpans(
  occurrences: WordOccurrence[],
  cleanText: string,
  annotations: FuriganaAnnotation[],
  freqReady: boolean
): Promise<WordOccurrence[]> {
  const sorted = [...occurrences].sort((a, b) => a.start - b.start);
  const out: WordOccurrence[] = [];
  let i = 0;
  while (i < sorted.length) {
    if (!isNumberRunMember(sorted[i]!)) {
      out.push(sorted[i]!);
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < sorted.length &&
      sorted[j + 1]!.start === sorted[j]!.end &&
      isNumberRunMember(sorted[j + 1]!)
    ) {
      j++;
    }
    const runStart = sorted[i]!.start;
    const runEnd = sorted[j]!.end;
    const surface = cleanText.slice(runStart, runEnd);
    if (![...surface].some((ch) => NUMERAL_CHARS.has(ch))) {
      // A lone counter (the 年 of 同じ年) — leave the members untouched.
      for (let k = i; k <= j; k++) out.push(sorted[k]!);
      i = j + 1;
      continue;
    }
    // Reading from the LLM ruby spanning the run — a counter looked up alone
    // stamps JMdict's default reading (年 → とし), not the run's (… → ねん).
    const reading = annotations
      .filter((a) => a.start >= runStart && a.end <= runEnd)
      .sort((a, b) => a.start - b.start)
      .map((a) => a.reading)
      .join("");
    const ranked =
      freqReady && lookupFrequencySync(surface, null).rank !== null;
    if (ranked) {
      out.push({
        start: runStart,
        end: runEnd,
        surface,
        headword: surface,
        reading,
        entryId: null,
        isName: false,
      });
    } else {
      for (const occ of await splitNumberRun(
        runStart,
        runEnd,
        surface,
        reading,
        cleanText
      )) {
        out.push(occ);
      }
    }
    i = j + 1;
  }
  return out;
}
