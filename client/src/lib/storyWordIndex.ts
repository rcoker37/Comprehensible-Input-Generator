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
import { getDictionaryState, lookupWord } from "./dictionary";
import { loadFrequencyIndex, lookupFrequencySync } from "./frequency";
import { headwordFromHit } from "./headword";
import { lookupAtBoundary, type LookupHit } from "./lookupAtCursor";
import { parseAnnotatedText, type FuriganaAnnotation } from "./furigana";
import { regroupWords } from "./regroupWords";
import { buildDisplaySegments, type AnnotatedPart } from "./storySegments";
import { stripBold } from "./text";
import {
  baseHintAtOffset,
  isProperNoun,
  posHintAtOffset,
  tokenizeText,
  type KuromojiTokenInfo,
} from "./tokenizer";
import type { WordResult } from "@birchill/jpdict-idb";
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
 *  18 — two fixes. (a) `subSegmentAnnotated` falls back to a per-character
 *       split when kuromoji collapses an annotated block into a single token:
 *       森中《もりじゅう》 (one 固有名詞 token) now indexes as 森 (もり) + 中
 *       (じゅう). It also re-picks each piece's JMdict entry to the one whose
 *       readings include the partition-assigned reading, so 中 resolves to the
 *       suffix entry (じゅう), not 中「なか」. (b) `lookupAtBoundary` deinflects an
 *       exact match that is a JPDB-unranked verb entry of an inflected form
 *       (`exactIsUnrankedInflectedVerb`): the causative 楽しませる resolves to
 *       its conjugated-from lemma 楽しむ instead of the standalone unranked
 *       楽しませる entry.
 *  19 — `lookupAtBoundary` auto-detects い-adjective 連用形 (古く → 古い) and
 *       何/数-led numbered words (何百万人).
 *  20 — `headwordFromHit` now derives the canonical headword from the resolved
 *       JMdict entry's first non-`sK` kanji form for *deinflected* hits too,
 *       instead of returning the (possibly kana) deinflection base. A `uk`
 *       verb like 居る now stamps 居る for every form — an exact いる tap and a
 *       conjugated います both — so the Stats Browse encounter count (keyed on
 *       the entry's `canonical`) no longer splits between 居る and いる.
 *  21 — the jpdb-by-entry index no longer attributes a bare-kana JPDB rank to
 *       every `uk` homophone reading it: the rank-18 kana surface いる belongs
 *       to 居る, so 要る now ranks 3,812 (not 18) and 癒る 23,034. This corrects
 *       the deinflection arbitration (`bestRank`), which had been picking the
 *       falsely-rank-18 要る for ambiguous kana spans.
 *  22 — `lookupAtBoundary` now takes a `baseHint` (kuromoji's in-context 基本形
 *       for the span's leading token); `pickDeinflection` prefers the candidate
 *       matching it before the JPDB-rank tiebreaker. 「〜ていった」 resolves to
 *       行く (kuromoji's lemma), not the merely-commoner 言う; できなかった to
 *       出来る, not the suppletive-potential する.
 *  23 — four pipeline fixes for the エヴァンゲリオン fixture's manual overrides.
 *       (a) `pickDeinflection` now applies `baseHint` as a tiebreaker *among*
 *       annotation-fitters instead of only when no annotation fits — fixes the
 *       partial-ruby case where two godan classes share the same -て / -ます
 *       form (分《わ》かって → 分かる, not 分かつ; 命《めい》じます → 命じる, not 命ずる).
 *       (b) `regroupWords` refuses a kuromoji-split exact-match merge whose
 *       leading token is a 助詞 and whose hit is into a kanji-canonical JMdict
 *       entry (`exactMergeStartsOnParticleIntoKanji`) — keeps と+の from
 *       collapsing into 殿 (rank 9260, slipped past the kana-rank veto) and
 *       に+し from collapsing into 螺 (a sibling 西 hit pulled the rank-veto's
 *       cross-entry minimum down enough to clear the threshold).
 *       (c) Bare でした now deinflects to です (the copula). The existing
 *       strip-to-empty rule still handles compound forms (静かでした → 静か).
 *       (d) `extractWordOccurrences` runs a post-pass (`detectKatakanaNames`)
 *       that emits a katakana run as a name span when at least one kuromoji
 *       token in the run is tagged `固有名詞` AND the run's JMdict lookup is
 *       either empty or only kanji-canonical non-`uk` entries. シンジ no
 *       longer maps to 神事; ゲンドウ no longer maps to 言動; ミサト merges
 *       even when kuromoji splits ミ+サト; ドイツ (uk) and ロボット (一般)
 *       stay as JMdict matches.
 *  24 — `lookupAtBoundary` recognises a na-adjective's prenominal な
 *       (`naAdjPrenominalHit`): a span ending in な whose stem is an adj-na
 *       JMdict entry resolves to that entry. JMdict has no entry for this な
 *       (it lives inside the copula だ), and a single-char な exact-matches
 *       the prohibitive particle (entry 2029110, "don't"), so 静か+な used to
 *       split into 静か + な (prohibitive). The regroup pass now merges 静かな
 *       into one tap target grouped under 静か.
 *  25 — two reading-coincidence fixes from the 真しんの世界線せかいせん fixture.
 *       (a) The exact-merge veto (`exactMergeStartsOnFunctionWordIntoKanji` in
 *       regroupWords.ts) is broadened from leading 助詞 to leading
 *       function words — particles *or* the copula auxiliary (助動詞 with
 *       basicForm だ / です). The な|の|か run in 「これが運命なのか」 no longer
 *       collapses into the kanji noun 七日 (なのか, "seventh day" — rank 12,559,
 *       under the very-rare threshold so the rank-based veto missed it).
 *       (b) `lookupAtBoundary` now lets a pure-kana JPDB-ranked fixed phrase
 *       (`exp` / `conj` / `int`) keep its exact-match entry when the competing
 *       deinflection lemma is no more than 10× more common
 *       (`expExactBeatsDeinflection`). 「そうすれば」 keeps 然うすれば (conj,
 *       rank 2316) instead of falling through to そうする (rank 815 ≈ 2.8×) —
 *       the existing `exactRankWins` only kept the exact when it strictly
 *       *outranked* the lemma, and the conj category is also new (the
 *       previous attempt was exp-only and 然うすれば is plain conj). 「により」
 *       still deinflects to に依る (rank 200) over the exp に因り (rank 22986
 *       ≈ 115×). Mirrors `exactIsUnrankedExpression` (an unranked phrase
 *       loses to deinflection entirely, e.g. 見られる → 見る).
 *  26 — two fixes for stamps the curator missed in earlier fixtures.
 *       (a) `lookupAtBoundary` hoists a verb-POS entry to `results[0]` when
 *       kuromoji tags the span 動詞 but jpdict-idb's intrinsic sort floated a
 *       non-verb homophone ahead of the verb (`hoistVerbToFrontWhen`). 「入って
 *       くる」 stamps 来る instead of 佝僂 (rank 25 verb vs unranked medical
 *       noun); narrow to 動詞 because a parallel noun-side preempt regresses
 *       curator-blessed picks (達 over 質 for たち).
 *       (b) `detectKatakanaNames` drops the previous "at least one 固有名詞
 *       token in the run" requirement and trusts `isAllKanjiCanonicalNonUk`
 *       alone. Kuromoji's IPADIC tags シンジ 固有名詞 only sometimes and
 *       skips ゲンドウ entirely, so the gated rule let 神事 / 言動 stamp on
 *       most occurrences. The bucket check on its own captures the real
 *       signal — the LLM picking katakana over the available kanji form
 *       means it's not the kanji homophone — at the cost of stylistic-
 *       katakana false positives (バンザイ for 万歳) that the user can
 *       override.
 *  27 — three fixes from the 千花ちかのボウリング教室 fixture audit.
 *       (a) `lookupAtBoundary` runs `hoistRankedToFront` on every returned
 *       hit, sorting `results` by JPDB rank ascending so `headwordFromHit`
 *       picks the most common entry. Fixes はず → 巴豆 (unranked) being
 *       stamped over 筈 (rank 206) and やさしく → 易しい (rank 4588) over
 *       優しい (rank 543). Generalises the previous verb-only hoist; the
 *       curator-blessed picks the verb-only hoist was narrow for (達 over
 *       質 for たち, の particle over 幅) all hold up under rank: the
 *       blessed pick is the rank champion in every case checked.
 *       (b) The verb-deinflection preempt in `lookupAtBoundary` (kuromoji
 *       tags 動詞 + exact has no verb POS) now defers to
 *       `expExactBeatsDeinflection` against the picked deinflection. Fixes
 *       「いえ」 mis-tagged as 動詞 / lemma 言える (rank 9596) when the
 *       interjection いえ "no" (entry 1583250, rank 573) is what the reader
 *       means — the existing fixed-phrase rule already covers this, it just
 *       wasn't running on this code path.
 *       (c) `extractWordOccurrences` checks for a single 固有名詞 kanji
 *       block before the numeral / sub-segment routing and emits it as a
 *       name span (`isName: true`, `entryId: null`). Fixes 藤原 being
 *       dropped entirely (sub-segment can't reconstruct ふじわら because わら
 *       isn't a JMdict reading of 原) and 千花 going through the numeral
 *       path (千 ∈ NUMERAL_CHARS) with `isName: false`.
 */
export const WORD_INDEX_VERSION = 27;

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
          // Single 固有名詞 kanji block — kuromoji's IPADIC name dictionary
          // recognised it as a proper noun. Try the normal sub-segment path
          // first: when partition succeeds it's a real compound (森中《もり
          // じゅう》 = 森 + 中 in 「森中に声が広がった」 — "throughout the
          // forest", not the surname Morinaka). When partition fails, the
          // block is a name JMdict can't reconstruct compositionally
          // (藤原《ふじわら》 — わら isn't a reading of 原; 千花《ちか》 — か
          // isn't 花's standalone reading) and we emit it as a name span.
          // Routes before the numeral check so 千花 doesn't get mis-handled
          // by the 千 numeral.
          const blockTokens = tokens.filter(
            (t) => t.start >= start && t.end <= end
          );
          if (
            blockTokens.length === 1 &&
            isProperNoun(blockTokens[0]!)
          ) {
            const subs = await subSegmentAnnotated(
              part,
              cleanText,
              annotations,
              tokens
            );
            if (subs.length > 0) {
              for (const sub of subs) emit(sub);
            } else {
              emit({
                start,
                end,
                surface: cleanText.slice(start, end),
                headword: cleanText.slice(start, end),
                reading: part.reading,
                entryId: null,
                isName: true,
              });
            }
            continue;
          }
          // A multi-character annotated block the LLM wrote starting with a
          // numeral — or a numeral qualifier (何百万人) — and carrying at least
          // one real numeral is a "numbered word" (一九二五年, 十四年, 二年前).
          // JMdict rarely has a whole-span entry for these — emit it whole here
          // and let `regroupNumberSpans` decide whether to keep it merged (JPDB
          // ranks it) or split the numeral run from its counter. The real-
          // numeral guard keeps a non-numeric 何-led block (何色) on the normal
          // sub-segmentation path.
          const block = cleanText.slice(start, end);
          if (
            end - start >= 2 &&
            isNumeralChar(block[0] ?? "") &&
            [...block].some((ch) => NUMERAL_CHARS.has(ch))
          ) {
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
  const named = await detectKatakanaNames(occurrences, cleanText, tokens);
  return regroupNumberSpans(named, cleanText, annotations, freqReady);
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
  const baseHint = await baseHintAtOffset(cleanText, start);
  const hit = await lookupAtBoundary(
    cleanText,
    start,
    end,
    annotations,
    posHint,
    baseHint
  );
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

// ---------------------------------------------------------------------------
// Katakana name detection
//
// Kuromoji's IPADIC tags character/place/organisation names as `名詞-固有名詞`
// (proper noun). For pure-katakana proper nouns the JMdict situation breaks
// into three buckets and the regular lookup pipeline mis-handles two of them:
//
//   1. No JMdict entry at all (エヴァンゲリオン, エヴァ, アスカ). The per-char
//      fallback splits the name into single-kana lookups (エ → 絵, オン → ＯＮ,
//      …) which is gibberish.
//   2. JMdict has a kanji-canonical entry whose reading folds onto the name
//      (シンジ → 神事, ゲンドウ → 言動). The lookup hits the kanji word the
//      reader almost certainly doesn't mean — the entry just happens to read
//      identically.
//   3. JMdict has a `uk` ("usually kana") entry whose reading is the surface
//      (ドイツ → 独逸, カナダ → 加奈陀). These are real, common loanwords; the
//      JMdict match is what the reader wants.
//
// Bucket 3 is the JMdict-the-reader-meant case, so the rule has to skip it.
// Buckets 1 and 2 are emitted as name spans (`isName=true`, `entryId=null`).
//
// Run-level detection is needed because kuromoji occasionally fragments a
// katakana name (ミサト → ミ「general」+ サト「proper noun」). Any contiguous
// katakana token run that contains *at least one* `固有名詞` token, where the
// run's surface either has no JMdict entry or only buckets-2 entries, is
// merged and emitted as one name span — replacing any per-token / per-char
// occurrences that fell inside the run.
//
// Single-token loanwords kuromoji tags `一般` (general — ロボット, レイ) miss
// this rule and keep their JMdict match. レイ specifically is ambiguous
// (could be a name or "ray") and stays a known gap.
// ---------------------------------------------------------------------------

function isKatakanaChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  // Full-width katakana block, including the prolonged-sound mark ー so ヴァー
  // doesn't break the run, plus half-width katakana.
  if (c >= 0x30a0 && c <= 0x30ff) return true;
  if (c >= 0xff66 && c <= 0xff9f) return true;
  return false;
}

function isKatakanaToken(token: KuromojiTokenInfo): boolean {
  for (const ch of token.surface) {
    if (!isKatakanaChar(ch)) return false;
  }
  return token.surface.length > 0;
}

/**
 * True when every JMdict `WordResult` is *kanji-canonical with no `uk` sense* —
 * i.e. the reader most likely doesn't mean the kanji word these readings fold
 * onto. シンジ → 神事/新字/鍼治 (all kanji, none uk) passes; ドイツ → 独逸 (kanji
 * with `uk`) fails. Empty list is treated as "all" and returns true so a
 * no-match surface routes to the name branch.
 *
 * Pure / no I/O — exported for unit tests.
 */
export function isAllKanjiCanonicalNonUk(results: WordResult[]): boolean {
  if (results.length === 0) return true;
  for (const wr of results) {
    const hasNonSkKanji = (wr.k ?? []).some(
      (k) => !(k.i ?? []).includes("sK")
    );
    if (!hasNonSkKanji) return false;
    const hasUk = (wr.s ?? []).some((sense) => sense.misc?.includes("uk"));
    if (hasUk) return false;
  }
  return true;
}

/**
 * Replace any per-token / per-char occurrence inside a katakana-name run with
 * one name span. A "katakana-name run" is a maximal contiguous sequence of
 * katakana kuromoji tokens whose surface JMdict lookup is either empty or
 * only matches kanji-canonical, non-`uk` entries (see
 * {@link isAllKanjiCanonicalNonUk}).
 *
 * Earlier versions also required at least one token in the run to be tagged
 * 固有名詞 by kuromoji. That was too conservative: kuromoji's IPADIC tags a
 * katakana name like シンジ as 固有名詞 only on some occurrences and 一般 on
 * others (Viterbi context-dependent), and skips ゲンドウ entirely — both then
 * leak their kanji homophones (神事, 言動) into the index. The bucket check
 * alone is the real signal: a katakana run with only-kanji-canonical-non-uk
 * JMdict matches means the LLM chose katakana over the kanji form on
 * purpose, which is almost always because the surface is a name. A
 * kana-canonical loanword (ロボット, k=[]) fails the bucket check and stays a
 * JMdict match; a `uk` kanji entry (ドイツ → 独逸) also fails. The remaining
 * false-positive class is kanji words written in katakana for stylistic
 * emphasis (バンザイ for 万歳) — uncommon in this corpus, and the user has
 * the manual override.
 *
 * Returns a new array; input is not mutated. Occurrences that don't intersect
 * any qualifying run are passed through unchanged. Pure logic plus one
 * `lookupWord` per candidate run.
 */
async function detectKatakanaNames(
  occurrences: WordOccurrence[],
  cleanText: string,
  tokens: KuromojiTokenInfo[]
): Promise<WordOccurrence[]> {
  const nameSpans: { start: number; end: number; surface: string }[] = [];

  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i]!;
    if (!isKatakanaToken(head)) {
      i++;
      continue;
    }
    // Maximal contiguous katakana run.
    let j = i;
    while (
      j + 1 < tokens.length &&
      tokens[j + 1]!.start === tokens[j]!.end &&
      isKatakanaToken(tokens[j + 1]!)
    ) {
      j++;
    }
    const start = head.start;
    const end = tokens[j]!.end;
    const surface = cleanText.slice(start, end);
    const exact = await lookupWord(surface);
    if (isAllKanjiCanonicalNonUk(exact)) {
      nameSpans.push({ start, end, surface });
    }
    i = j + 1;
  }

  if (nameSpans.length === 0) return occurrences;

  // Drop any occurrence whose [start, end) intersects a name run; then add the
  // name spans themselves.
  const intersects = (
    occ: WordOccurrence,
    run: { start: number; end: number }
  ): boolean => occ.start < run.end && occ.end > run.start;
  const survivors = occurrences.filter(
    (occ) => !nameSpans.some((run) => intersects(occ, run))
  );
  for (const run of nameSpans) {
    survivors.push({
      start: run.start,
      end: run.end,
      surface: run.surface,
      headword: run.surface,
      reading: run.surface,
      entryId: null,
      isName: true,
    });
  }
  survivors.sort((a, b) => a.start - b.start);
  return survivors;
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

/** One piece of a sub-segmented annotated block, before reading partition. */
interface SubSegmentSpan {
  start: number;
  end: number;
  /** The kuromoji token covering the piece, when the split is kuromoji-tiled.
   *  Absent for the per-character fallback. */
  token?: KuromojiTokenInfo;
}

/**
 * The kuromoji tokens tiling [part.start, part.end) exactly — ≥2 of them,
 * contiguous, no overhang. Returns null when they don't tile (kuromoji
 * collapsed the block into one token, or its tokens overhang the block).
 */
function kuromojiTiling(
  part: AnnotatedPart,
  tokens: KuromojiTokenInfo[]
): SubSegmentSpan[] | null {
  const inside = tokens.filter(
    (t) => t.start >= part.start && t.end <= part.end
  );
  if (inside.length < 2) return null;
  let cursor = part.start;
  for (const t of inside) {
    if (t.start !== cursor) return null;
    cursor = t.end;
  }
  if (cursor !== part.end) return null;
  return inside.map((t) => ({ start: t.start, end: t.end, token: t }));
}

/** One span per character of the block — the fallback when kuromoji won't
 *  tile the block (森中《もりじゅう》 is a single 固有名詞 token). */
function perCharSpans(part: AnnotatedPart): SubSegmentSpan[] {
  const spans: SubSegmentSpan[] = [];
  for (let i = part.start; i < part.end; i++) {
    spans.push({ start: i, end: i + 1 });
  }
  return spans;
}

/**
 * Sub-segment a multi-kanji annotated block the LLM wrote as one ruby unit but
 * JMdict has no whole-span entry for. Prefers the kuromoji tokenisation —
 * 普通選挙法 splits into 普通 / 選挙 / 法 (all JMdict words) — but when kuromoji
 * collapses the block into a single token (森中《もりじゅう》 is one 固有名詞
 * token) it falls back to a per-character split so a compound JMdict lacks a
 * whole-span entry for is still indexed piece-by-piece.
 *
 * A piece kuromoji tags 固有名詞 (proper noun) is emitted as a *name* — surface
 * as headword, `entryId=null`, `isName=true` — so the popover shows a "Name"
 * header rather than the unrelated common-noun JMdict entry (山手 inside
 * 山手線《やまのてせん》 is the railway-line name, not the noun「hilly uptown
 * district」). The per-character fallback has no kuromoji token per piece, so
 * those pieces are never names. A non-name piece must resolve to a JMdict
 * headword or the whole split is rejected.
 *
 * The split is trusted only when some assignment of candidate readings to the
 * pieces reconstructs the LLM's ruby for the whole block — every reading JMdict
 * lists for a piece's entry plus the kuromoji reading is tried, not just the
 * piece's default. That lets 山手線《やまのてせん》 split into 山手 (やまのて) +
 * 線 (せん) even though 山手's default reading is the commoner やまて, and 森中
 * 《もりじゅう》 into 森 (もり) + 中 (じゅう), while a non-compositional 熟字訓
 * like 五月雨《さみだれ》 has no valid partition and is left unindexed. Each
 * piece is stamped with the reading the partition assigned it, and its JMdict
 * entry is the one whose readings include that reading (中 → the suffix entry
 * じゅう, not 中「なか」). Returns [] (no sub-spans) on any miss.
 */
async function subSegmentAnnotated(
  part: AnnotatedPart,
  cleanText: string,
  annotations: FuriganaAnnotation[],
  tokens: KuromojiTokenInfo[]
): Promise<WordOccurrence[]> {
  const spans = kuromojiTiling(part, tokens) ?? perCharSpans(part);
  if (spans.length < 2) return [];

  // Resolve each piece, collecting every candidate reading so the block ruby
  // can be partitioned compositionally even when a piece's reading isn't its
  // commonest one. A 固有名詞 token becomes a name; any other piece must
  // resolve to a JMdict headword.
  const pieces: {
    start: number;
    end: number;
    surface: string;
    isName: boolean;
    hit: LookupHit | null;
    readings: string[];
  }[] = [];
  for (const span of spans) {
    const surface = cleanText.slice(span.start, span.end);
    const posHint = await posHintAtOffset(cleanText, span.start);
    const hit = await lookupAtBoundary(
      cleanText,
      span.start,
      span.end,
      annotations,
      posHint
    );
    const headword = hit ? headwordFromHit(hit) : null;
    const readings = new Set<string>();
    readings.add(kataToHira(surface));
    if (headword?.reading) readings.add(headword.reading);
    for (const wr of hit?.results ?? []) {
      for (const r of wr.r ?? []) readings.add(r.ent);
    }
    const isName = span.token ? isProperNoun(span.token) : false;
    if (!isName && (!hit || !headword)) {
      // A non-name piece JMdict can't resolve — don't trust the split.
      return [];
    }
    pieces.push({
      start: span.start,
      end: span.end,
      surface,
      isName,
      hit,
      readings: [...readings],
    });
  }

  const assigned = partitionReading(
    part.reading,
    pieces.map((p) => p.readings)
  );
  if (!assigned) return [];

  return pieces.map((p, i) => {
    const reading = assigned[i]!;
    if (p.isName || !p.hit) {
      return {
        start: p.start,
        end: p.end,
        surface: p.surface,
        headword: p.surface,
        reading,
        entryId: null,
        isName: p.isName,
      };
    }
    // Hoist the JMdict result whose readings include the partition's assigned
    // reading, so the stamped entry/headword agree with the LLM ruby: 中 in
    // 森中《もりじゅう》 resolves to the suffix entry (じゅう), not 中「なか」.
    const ordered = [...p.hit.results].sort(
      (a, b) =>
        Number((b.r ?? []).some((r) => r.ent === reading)) -
        Number((a.r ?? []).some((r) => r.ent === reading))
    );
    const resolved = headwordFromHit({
      ...p.hit,
      results: ordered,
      preferredReading: reading,
    });
    return {
      start: p.start,
      end: p.end,
      surface: p.surface,
      headword: resolved?.headword ?? p.surface,
      reading: resolved?.reading ?? reading,
      entryId: ordered[0]?.id ?? null,
      isName: false,
    };
  });
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

// Characters that qualify a numeric expression without being numerals
// themselves — 何 ("how many": 何百万人) and 数 ("several": 数百万). Treated as
// numerals by `isNumeralChar` so a block like 何百万人, which kuromoji and
// JMdict won't whole-span, still routes through the number-span splitter and
// has its trailing counter (人) peeled off.
const NUMERAL_QUALIFIER_CHARS = new Set("何数");

// Common counter kanji. Used to recognise an all-numeral/counter occurrence
// as a number fragment; a numeral-led occurrence with no JMdict entry is also
// treated as a fragment, so this set need not be exhaustive.
const COUNTER_CHARS = new Set(
  "年月日時分秒円才歳人名回度個本冊枚台匹頭羽階番号周件票杯軒着足歩点語字句行巻通発丁"
);

function isNumeralChar(ch: string): boolean {
  return NUMERAL_CHARS.has(ch) || NUMERAL_QUALIFIER_CHARS.has(ch);
}

/**
 * True when every character is a numeral or a counter. Numeral *qualifiers*
 * (何/数) are deliberately excluded: a bare 何 is the interrogative "what", a
 * normal word — it joins a number run only via {@link isNumberAtom}'s
 * entry-less-block branch. Exported for unit testing alongside
 * {@link longestReadingSuffix}.
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
  // 二年前 whose remainder (年前) isn't purely counters, or 何百万人.
  return isNumeralChar(o.surface[0]!) && o.entryId === null;
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
 *
 * `isName` propagates onto the merged-fallback span. The number routing can
 * end up holding a 固有名詞 block (千花《ちか》 is numeral-led because 千 is a
 * NUMERAL_CHAR, and 花 has no か reading so the peel fails), and the merged
 * fallback would otherwise hard-code `isName: false` and silently strip the
 * surname flag the upstream emit set.
 */
async function splitNumberRun(
  runStart: number,
  runEnd: number,
  surface: string,
  reading: string,
  cleanText: string,
  isName: boolean
): Promise<WordOccurrence[]> {
  const merged: WordOccurrence = {
    start: runStart,
    end: runEnd,
    surface,
    headword: surface,
    reading,
    entryId: null,
    isName,
  };
  // Leading maximal numeral run.
  let ns = runStart;
  while (ns < runEnd && isNumeralChar(cleanText[ns]!)) ns++;
  // A pure number (no counter) — nothing to peel.
  if (ns >= runEnd) return [merged];

  const tail: WordOccurrence[] = [];
  let rem = reading;
  for (let pos = runEnd - 1; pos >= ns; pos--) {
    const hit = await lookupAtBoundary(cleanText, pos, pos + 1, []);
    if (!hit) return [merged];
    const readings = hit.results.flatMap((wr) => wr.r?.map((r) => r.ent) ?? []);
    const match = longestReadingSuffix(rem, readings);
    if (!match) return [merged];
    // Hoist the JMdict entry whose readings include the peeled reading, so the
    // stamped entry/headword agree with the counter's actual reading: 人 with
    // reading にん resolves to the counter entry, not 人「ひと」.
    const ordered = [...hit.results].sort(
      (a, b) =>
        Number((b.r ?? []).some((r) => r.ent === match)) -
        Number((a.r ?? []).some((r) => r.ent === match))
    );
    const hw = headwordFromHit({
      ...hit,
      results: ordered,
      preferredReading: match,
    });
    if (!hw) return [merged];
    rem = rem.slice(0, rem.length - match.length);
    tail.unshift({
      start: pos,
      end: pos + 1,
      surface: cleanText[pos]!,
      headword: hw.headword,
      reading: match,
      entryId: ordered[0]?.id ?? null,
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
      // No real numeral — a lone counter (the 年 of 同じ年), or a 何/数
      // qualifier with nothing numeric to qualify. Leave the members untouched.
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
    // Preserve `isName` from the run's first member onto the merged span — a
    // 固有名詞 block like 千花 routes through this path because 千 is a
    // numeral char, and the merged emit hard-coding `false` would silently
    // strip the name flag (see {@link splitNumberRun}).
    const runIsName = sorted[i]!.isName;
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
        isName: runIsName,
      });
    } else {
      for (const occ of await splitNumberRun(
        runStart,
        runEnd,
        surface,
        reading,
        cleanText,
        runIsName
      )) {
        out.push(occ);
      }
    }
    i = j + 1;
  }
  return out;
}
