// Walks the DisplayParagraph[] from `buildDisplaySegments` and merges parts
// into longer WordParts using kuromoji as the boundary oracle and JMdict
// (with deinflection) as the dictionary check. The merge can cross
// AnnotatedPart boundaries — a kanji's LLM-supplied ruby and the okurigana
// that follows are independent parts after parsing, but a single tap target
// for the user. The merged WordPart carries those sub-annotations as
// `rubies` so the renderer can put the ruby back over the right kanji.
//
// Why kuromoji + JMdict? Pure-greedy lookup over JMdict picks the longest
// entry it can find, which fails on hira-only ambiguity: 「Xがあります」
// contains 「があ」 (an interjection in JMdict), so greedy merges 「が」 and
// 「あ」 into 「があ」 and leaves 「ります」 dangling. Pure kuromoji has the
// opposite problem — it can over-segment compounds (千|九|百|年代) or miss
// multi-token merges that JMdict knows are one word (食べ|まし|た as
// 食べました). The hybrid: at each cursor only accept a JMdict hit whose end
// aligns with a kuromoji boundary (or a part/sentence boundary). That
// rejects 「があ」 (ends mid-token) and accepts 「あります」 (ends on the
// boundary that closes the あり|ます chain).
//
// One more guard runs the other way. JMdict carries entries that aren't the
// word the reader is looking at when a kuromoji-split run is concerned:
//   - kana particle runs (では, これは) and reading coincidences (さは, which
//     exact-matches 左派, "left wing");
//   - `exp` *expression* entries — multi-word phrases like 雨が降る and
//     家を出る, a noun + particle + verb JMdict lists as one idiom.
// When kuromoji splits で|は, さ|は or 雨|が|降り the alignment rule would
// happily merge the pieces back into that JMdict entry. So a merge is refused
// when it crosses a kuromoji boundary and `rareMergeProbe` flags it: JPDB
// ranks the entry no better than the very-rare tier (or not at all). For a
// kana run the surface must additionally be kana-only; for an expression the
// rank alone decides, kana or kanji-bearing. JPDB ranks lexicalised compound
// particles (には 22, とは 71) and the expressions common enough to be words
// in their own right (青くなる 14,750, 木の葉 13,023), so those keep merging;
// 左派 (62,243), では and 雨が降る / 家を出る (all unranked) don't. The
// kana-only gate is what lets a non-expression kanji compound JPDB happens not
// to list — 高さ, which JPDB folds into the adjective 高い — merge anyway: a
// kanji-bearing surface is vetoed only when it is an expression entry.
//
// The expression veto covers deinflected merges (雨が降り → 雨が降る) as well
// as exact ones; a plain verb conjugation (食べ|まし|た → 食べました) is not an
// expression, so it still merges. Neither veto applies when kuromoji split the
// span into only a content word + its auxiliary chain (いらっしゃい|ませ): that
// is a single inflected word, not a multi-word phrase, even when JMdict also
// lists the surface as a fixed `exp` greeting — see `spanIsInflectedSingleWord`.
// One more deinflection guard: 「外はもう…」
// splits は|もう, but JMdict deinflects 「はもう」 to the volitional of the
// rare verb 食む (はむ) — rank 25,527, inside the `rare` tier, so the rank veto
// lets it through. A deinflection chain can only *start* on a content word,
// so a merge is also refused when it deinflects across a kuromoji boundary and
// kuromoji tagged its leading token a particle — see
// `deinflectionMergeStartsOnParticle`.
//
// Async because both kuromoji init and dictionary lookups are async. Callers
// await once per story; the tokenizer init is amortised across calls.

import {
  annotationContradictsHit,
  isPureKana,
  lookupAtBoundary,
  type LookupHit,
} from "./lookupAtCursor";
import {
  loadFrequencyIndex,
  lookupFrequencyByEntrySync,
  lookupFrequencySync,
} from "./frequency";
import {
  isCopulaToken,
  tokenizeText,
  verbHintAt,
  type KuromojiTokenInfo,
} from "./tokenizer";
import { KANJI_REGEX } from "./constants";
import type {
  DisplayParagraph,
  DisplaySentence,
  SegmentPart,
  WordPart,
} from "./storySegments";
import type { FuriganaAnnotation } from "./furigana";

export type LookupAtBoundaryFn = typeof lookupAtBoundary;
export type TokenizeFn = (text: string) => Promise<KuromojiTokenInfo[]>;

/**
 * A merge-veto probe. Given a candidate merge hit, returns true to refuse the
 * merge because JPDB doesn't rank the matched entry as a real word. Injectable
 * so tests can drive the veto deterministically without real frequency data;
 * production uses {@link defaultRareMergeProbe}.
 */
export type RareMergeProbe = (hit: LookupHit) => boolean | Promise<boolean>;

export async function regroupWords(
  paragraphs: DisplayParagraph[],
  cleanText: string,
  annotations: FuriganaAnnotation[],
  lookup: LookupAtBoundaryFn = lookupAtBoundary,
  tokenize: TokenizeFn = tokenizeText,
  rareMergeProbe: RareMergeProbe = defaultRareMergeProbe
): Promise<DisplayParagraph[]> {
  const tokens = await tokenize(cleanText);
  const boundaries = tokens.map((t) => t.end); // sorted ascending by construction

  // Boundaries that land between a content verb (動詞) and a trailing
  // conjugation auxiliary (助動詞). A merge ending exactly here would orphan
  // the aux from its stem — e.g. 「に|し|ます」 has end=2 (after し), which
  // matches JMdict's 「にし」 (西=west) by surface alone but is wrong in
  // context. Pass 1 still tries the longer span (which deinflects via the
  // polite ます rule), so 「あります」「食べました」 keep working; only the
  // orphan-the-aux case is rejected.
  //
  // The copula (だ / です) is excluded: it attaches to a *noun*, never
  // continues a verb conjugation, so a 動詞-tagged token before it is a
  // complete word (the 連用形 noun 終わり in 終わり + だった) and merging up to
  // that boundary is correct.
  const auxAfterVerbBoundaries = new Set<number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const cur = tokens[i]!;
    const next = tokens[i + 1]!;
    if (cur.pos === "動詞" && next.pos === "助動詞" && !isCopulaToken(next)) {
      auxAfterVerbBoundaries.add(cur.end);
    }
  }

  // Per-token POS hint keyed by token start offset. Passed to
  // lookupAtBoundary so it can disambiguate cases like 「赤くなり、」 where
  // kuromoji says なり is 動詞 (continuative of なる) but JMdict has an
  // unrelated noun entry that would otherwise short-circuit deinflection.
  // `verbHintAt` drops the 動詞 hint when the token is a 連用形 noun followed
  // by the copula (終わり + だった), so the noun exact-match wins.
  const posByStart = new Map<number, string>();
  // Parallel map of kuromoji's in-context lemma (基本形) per token start —
  // passed alongside the POS hint so lookupAtBoundary can disambiguate
  // homophone deinflections (「〜ていった」 → 行く, not 言う).
  const baseByStart = new Map<number, string>();
  // Parallel map of the leading kuromoji token itself per token start —
  // exposed so the function-word merge veto can read the token's basicForm,
  // not just its POS (a copula 助動詞 「な」 has basicForm=だ, but kuromoji
  // also tags た / ます / ない as 助動詞 — they're not function words that
  // veto a kanji-noun merge).
  const tokenByStart = new Map<number, KuromojiTokenInfo>();
  for (let i = 0; i < tokens.length; i++) {
    const hint = verbHintAt(tokens, i);
    if (hint !== undefined) posByStart.set(tokens[i]!.start, hint);
    const base = tokens[i]!.basicForm;
    if (base && base !== "*") baseByStart.set(tokens[i]!.start, base);
    tokenByStart.set(tokens[i]!.start, tokens[i]!);
  }

  const result: DisplayParagraph[] = [];
  for (const para of paragraphs) {
    const newSentences: DisplaySentence[] = [];
    for (const sent of para.sentences) {
      const newParts = await regroupParts(
        sent.parts,
        cleanText,
        annotations,
        lookup,
        boundaries,
        tokens,
        auxAfterVerbBoundaries,
        posByStart,
        baseByStart,
        tokenByStart,
        rareMergeProbe
      );
      newSentences.push({ ...sent, parts: newParts });
    }
    result.push({ sentences: newSentences });
  }
  return result;
}

interface IndexedPart {
  start: number;
  end: number;
  part: SegmentPart;
}

async function regroupParts(
  parts: SegmentPart[],
  cleanText: string,
  annotations: FuriganaAnnotation[],
  lookup: LookupAtBoundaryFn,
  boundaries: number[],
  tokens: KuromojiTokenInfo[],
  auxAfterVerbBoundaries: Set<number>,
  posByStart: Map<number, string>,
  baseByStart: Map<number, string>,
  tokenByStart: Map<number, KuromojiTokenInfo>,
  rareMergeProbe: RareMergeProbe
): Promise<SegmentPart[]> {
  if (parts.length === 0) return [];

  // Index each part's [start, end) so all merge-end checks talk about the
  // same offset space. We never split a part — every merge ends on a part
  // boundary so an annotation either stays whole or is fully absorbed.
  const indexed: IndexedPart[] = parts.map((p) => {
    if (p.kind === "char") return { start: p.offset, end: p.offset + 1, part: p };
    return { start: p.start, end: p.end, part: p };
  });
  const sentEnd = indexed[indexed.length - 1]!.end;
  const kBounds = new Set(boundaries);
  // Annotation starts and ends are strong word boundaries — the LLM put a
  // ruby block there, so the kanji span is a discrete unit. Treating these
  // as aligned lets the regroup pass end a merge at an annotation boundary
  // even when kuromoji didn't put a token boundary there.
  const annBounds = new Set<number>();
  for (const a of annotations) {
    annBounds.add(a.start);
    annBounds.add(a.end);
  }

  const out: SegmentPart[] = [];
  let i = 0;

  while (i < indexed.length) {
    const head = indexed[i]!;
    const start = head.start;

    // Eligible end offsets are part ends from index `i` onward.
    const partEnds: number[] = [];
    for (let j = i; j < indexed.length; j++) partEnds.push(indexed[j]!.end);

    const isAligned = (b: number) =>
      kBounds.has(b) || annBounds.has(b) || b === sentEnd;

    let mergedTo = -1; // pi value of the chosen end, -1 if none

    // Pass 1: longest aligned part end ≥ 2 chars. Kuromoji tokens usually
    // mark the right ceiling; when JMdict knows a longer span via
    // deinflection (食べ|まし|た as 食べました), it shows up at a later
    // boundary in the same sentence. Boundaries that orphan an auxiliary
    // from its verb stem are skipped so 「にし|ます」 doesn't pull 「にし」
    // (西=west) out of 「にします」.
    for (let pi = partEnds.length - 1; pi >= 0; pi--) {
      const b = partEnds[pi]!;
      const len = b - start;
      if (len < 2) continue;
      if (!isAligned(b)) continue;
      if (auxAfterVerbBoundaries.has(b)) continue;
      const hit = await lookup(
        cleanText,
        start,
        b,
        annotations,
        posByStart.get(start),
        baseByStart.get(start)
      );
      // Reject a hit whose entry reading the LLM furigana contradict — e.g.
      // 今日《きょう》は must not merge into the greeting こんにちは.
      if (!hit || annotationContradictsHit(hit, annotations)) continue;
      const crosses = crossesKuromojiBoundary(start, b, boundaries);
      // Refuse a merge that glues a kuromoji-split span into a JMdict entry
      // JPDB has never ranked as a word. Two shapes are eligible: any exact
      // match (で|は → では, これ|は → これは, さ|は → 左派) and — even via
      // deinflection — a JMdict `exp` expression entry (雨が降り → 雨が降る,
      // 家を出て → 家を出る). A plain verb conjugation (食べ|まし|た →
      // 食べました) is neither, so it still merges. Kuromoji already draws the
      // right noun|particle|verb boundaries, so deferring to its split is safe;
      // `rareMergeProbe` makes the JPDB-rank call.
      //
      // The veto exists for *multi-word* spans — phrases with a particle in
      // their middle and particle runs. A span kuromoji split into only a
      // content word + its auxiliary chain (いらっしゃい+ませ) is a single
      // inflected word, even when JMdict happens to double-list it as an `exp`
      // entry; `spanIsInflectedSingleWord` exempts it so 「いらっしゃいませ」
      // merges instead of shattering into single kana.
      if (
        crosses &&
        !spanIsInflectedSingleWord(start, b, tokens) &&
        (!hit.base || hitIsExpression(hit)) &&
        (await rareMergeProbe(hit))
      ) {
        continue;
      }
      // Refuse a deinflection merge whose leading kuromoji token is a
      // particle: a verb/adjective conjugation can't begin on one. 「は|もう」
      // would otherwise deinflect to the volitional of the rare verb 食む.
      if (crosses && deinflectionMergeStartsOnParticle(hit, posByStart.get(start))) {
        continue;
      }
      // Same shape for exact matches: a function-word-led kuromoji-split merge
      // into a kanji-canonical JMdict entry (殿, 螺, 七日) is a reading
      // coincidence, not the word the reader is looking at — for both
      // particles (と|の → 殿) and the copula auxiliary (な|の|か → 七日, where
      // な is kuromoji's 助動詞 form of だ). Compound particles like には are
      // kana-canonical and pass.
      if (
        crosses &&
        exactMergeStartsOnFunctionWordIntoKanji(hit, tokenByStart.get(start))
      ) {
        continue;
      }
      mergedTo = pi;
      break;
    }

    // Pass 2: kanji-containing fallback at non-aligned part ends. Catches
    // counters like 「四つ」 when kuromoji segments 「四|つの」 instead of
    // 「四つ|の」, without re-introducing hira-only false positives like
    // 「があ」 inside 「があります」.
    if (mergedTo === -1) {
      for (let pi = partEnds.length - 1; pi >= 0; pi--) {
        const b = partEnds[pi]!;
        const len = b - start;
        if (len < 2) continue;
        if (isAligned(b)) continue;
        if (!hasKanji(cleanText, start, b)) continue;
        const hit = await lookup(
        cleanText,
        start,
        b,
        annotations,
        posByStart.get(start),
        baseByStart.get(start)
      );
        if (hit && !annotationContradictsHit(hit, annotations)) {
          mergedTo = pi;
          break;
        }
      }
    }

    if (mergedTo === -1) {
      out.push(head.part);
      i++;
      continue;
    }

    const end = partEnds[mergedTo]!;
    out.push(buildMergedPart(indexed, i, mergedTo, start, end, cleanText, annotations));
    i += mergedTo + 1;
  }

  return out;
}

/**
 * Build the merged result. When the merge consumed only one part (toRel === 0)
 * we return that part untouched — it's already its own valid tap target and
 * wrapping a single AnnotatedPart in a WordPart would lose the
 * `kind: "annotated"` discriminator the renderer reads.
 */
function buildMergedPart(
  indexed: IndexedPart[],
  from: number,
  toRel: number,
  start: number,
  end: number,
  cleanText: string,
  annotations: FuriganaAnnotation[]
): SegmentPart {
  if (toRel === 0) return indexed[from]!.part;
  const rubies = annotations.filter((a) => a.start >= start && a.end <= end);
  const result: WordPart = {
    kind: "word",
    start,
    end,
    surface: cleanText.slice(start, end),
  };
  if (rubies.length > 0) result.rubies = rubies;
  return result;
}

function hasKanji(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (KANJI_REGEX.test(text[i]!)) return true;
  }
  return false;
}

/**
 * True when at least one kuromoji token boundary falls strictly inside
 * [start, end) — i.e. kuromoji split this span into two or more tokens.
 * `boundaries` is the sorted list of every token end offset in the text.
 * Exposed for unit tests.
 */
export function crossesKuromojiBoundary(
  start: number,
  end: number,
  boundaries: number[]
): boolean {
  return boundaries.some((b) => b > start && b < end);
}

/** kuromoji's part-of-speech tag for particles (助詞). */
const PARTICLE_POS = "助詞";

/** kuromoji's part-of-speech tag for conjugation auxiliaries (助動詞). */
const AUXILIARY_POS = "助動詞";

/**
 * True when every kuromoji token that begins strictly inside [start, end) is a
 * conjugation auxiliary (助動詞) — i.e. kuromoji split this span into a single
 * content word followed only by its inflection chain (いらっしゃい+ます,
 * 食べ+まし+た), not into independent words. Such a span is one morphological
 * word, so the kuromoji-split merge veto — which exists to keep
 * noun+particle+verb phrases and particle runs split — must not apply to it,
 * even when JMdict also lists the surface as an `exp` expression (the fixed
 * greeting いらっしゃいませ).
 *
 * Requires at least one internal token: with none the span doesn't cross a
 * kuromoji boundary at all and the veto already wouldn't run.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function spanIsInflectedSingleWord(
  start: number,
  end: number,
  tokens: KuromojiTokenInfo[]
): boolean {
  let internal = 0;
  for (const t of tokens) {
    if (t.start <= start || t.start >= end) continue;
    internal++;
    if (t.pos !== AUXILIARY_POS) return false;
  }
  return internal > 0;
}

/**
 * Veto decision for the leading-particle counterpart of the JPDB-rank merge
 * veto: should a kuromoji-split deinflection merge be refused, given the
 * candidate `hit` and the kuromoji POS of the span's leading token?
 *
 * A deinflection chain (食べ|まし|た → 食べる) is a conjugated verb or
 * adjective, so it can only *start* on a content word. When kuromoji tags the
 * leading token as a particle, the "deinflection" is a coincidence — は|もう
 * deinflects to the volitional of the rare verb 食む — and the merge is wrong.
 * Exact matches are out of scope here (see
 * {@link exactMergeStartsOnParticleIntoKanji}); only `hit.base` hits apply.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function deinflectionMergeStartsOnParticle(
  hit: LookupHit,
  leadingPos: string | undefined
): boolean {
  return Boolean(hit.base) && leadingPos === PARTICLE_POS;
}

/**
 * Veto decision for the exact-match counterpart of
 * {@link deinflectionMergeStartsOnParticle}: should a kuromoji-split *exact*
 * merge be refused, given the candidate `hit` and the kuromoji token at the
 * span's leading position?
 *
 * Fires when all four hold:
 *   1. surface is pure-kana,
 *   2. leading kuromoji token is a function word — either a particle (助詞)
 *      or the copula auxiliary (助動詞 with basicForm だ / です),
 *   3. matched JMdict entry has at least one non-`sK` kanji form, AND
 *   4. no sense of the entry is tagged `exp` (multi-word expression).
 *
 * Reading-folding lets a pure-kana function-word run (と|の, に|し, な|の|か)
 * collide with kanji words read identically (殿/との, 螺/にし, 七日/なのか) —
 * and the existing JPDB-rank veto can miss those when the entry happens to
 * clear the very-rare threshold (殿 rank 9260; 七日 rank 12559) or when a
 * sibling rank pulls the cross-entry minimum down (にし also hits 西 rank
 * 1960). A function word is not the start of a single-word kanji noun in
 * those cases, so the merge is wrong. The copula branch is what lets
 * 「運命なのか」 stay 運命+なの+か rather than collapsing the な-の-か run into
 * 七日 (なのか, "seventh day"): kuromoji tags な as 助動詞/だ here, so the
 * particle-only rule wouldn't fire, but a copula at the start of a kana run
 * blocking a kanji-canonical noun is the same reading-coincidence pattern.
 *
 * Three exits keep legitimate merges flowing:
 *   - Pure-kana surface (gate 1): kanji-bearing surfaces with a leading kana
 *     particle are genuine compounds where the kanji is *part of* the phrase —
 *     に当たり (に+当たり), かも知れません (か+も+知れ+ません) keep merging.
 *   - Kana-canonical entry (gate 3): JMdict's compound particles JPDB ranks
 *     (には 22, とは 71, でも) all have k=[], so they keep merging.
 *   - `exp` POS (gate 4): a JMdict entry tagged `exp` is a multi-word phrase
 *     by construction, so a function-word-led merge into it is exactly the
 *     intended shape — の様に (のように), 五月雨, なの (rank 99 exp), etc. The
 *     standalone-word entries (殿, 螺, 七日, 八百) carry only `n`-family POS
 *     and stay vetoed.
 *
 * Deinflection merges are out of scope here ({@link
 * deinflectionMergeStartsOnParticle} handles them and *doesn't* require the
 * kanji-canonical or exp gates, because no compound particle is also a
 * deinflectable verb). The auxiliary-only side of 助動詞 (た, ます, ない) is
 * intentionally excluded: those never appear as the first token of an
 * independent span — they only attach to verb stems — so adding them would
 * be vacuous, while a copula 「な」 / 「だ」 routinely opens a kana run.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function exactMergeStartsOnFunctionWordIntoKanji(
  hit: LookupHit,
  leadingToken: KuromojiTokenInfo | undefined
): boolean {
  if (hit.base) return false;
  if (!leadingToken) return false;
  const isParticle = leadingToken.pos === PARTICLE_POS;
  const isCopula = isCopulaToken(leadingToken);
  if (!isParticle && !isCopula) return false;
  if (!isPureKana(hit.surface)) return false;
  const entry = hit.results[0];
  if (!entry) return false;
  const hasNonSkKanji = (entry.k ?? []).some(
    (k) => !(k.i ?? []).includes("sK")
  );
  if (!hasNonSkKanji) return false;
  const isExpression = (entry.s ?? []).some((sense) =>
    sense.pos?.includes(EXPRESSION_POS)
  );
  if (isExpression) return false;
  return true;
}

/**
 * Rank ceiling for the JPDB-rank merge veto. A merged span whose best JPDB
 * rank is worse than this — or unranked entirely — is treated as too rare to
 * be the word the reader is looking at. 30,000 is the `rare` / `very-rare`
 * tier boundary (see `rankToTier`): 左派 (さは) sits at 62,243 so さ|は stays
 * split, while JPDB-ranked compound particles には (22) / とは (71) clear it
 * comfortably and keep merging.
 */
export const RARE_MERGE_MAX_RANK = 30_000;

/**
 * True when a best-known JPDB `rank` (null = unranked / absent from JPDB) is
 * too rare to trust a kuromoji-split merge — unranked, or worse than the
 * very-rare tier boundary. Pure / no I/O — exposed for unit tests.
 */
export function rankTooRareToMerge(rank: number | null): boolean {
  return rank === null || rank > RARE_MERGE_MAX_RANK;
}

/**
 * Pure veto decision for the kana branch of {@link defaultRareMergeProbe}:
 * should a kuromoji-split exact-match merge be refused, given the merged
 * `surface` and its best known JPDB `rank`?
 *
 * Only kana-only surfaces are eligible. A non-expression surface containing a
 * kanji is a word the LLM deliberately wrote and JMdict exact-matched, so it
 * always merges — this is what keeps 高《たか》さ → 高さ working even though
 * JPDB has no entry for 高さ at all (JPDB folds it into the adjective 高い,
 * just as kuromoji tags 高 as 形容詞 + さ as 接尾辞). Among kana-only surfaces,
 * the merge is refused when the span is unranked or ranked no better than the
 * very-rare tier — a reading coincidence like さ|は = 左派, or a particle run
 * like で|は = では, is not the word the reader is looking at.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function kanaSpanTooRareToMerge(
  surface: string,
  rank: number | null
): boolean {
  if (!isPureKana(surface)) return false;
  return rankTooRareToMerge(rank);
}

/** JMdict part-of-speech tag for a multi-word expression / phrase. */
const EXPRESSION_POS = "exp";

/**
 * True when the entry this hit would merge into is a JMdict `exp` expression —
 * a multi-word phrase (雨が降る, 家を出る, 木の葉) rather than a single lexical
 * word. Reads `results[0]`, the entry the indexer stamps. Such a phrase, when
 * JPDB doesn't rank it, should defer to kuromoji's word-level split rather
 * than swallow the particle in its middle.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function hitIsExpression(hit: LookupHit): boolean {
  const entry = hit.results[0];
  if (!entry) return false;
  return (entry.s ?? []).some((sense) => sense.pos?.includes(EXPRESSION_POS));
}

/**
 * The default {@link RareMergeProbe}. Vetoes a kuromoji-split merge when JPDB
 * ranks the matched JMdict entry no better than the very-rare tier (or not at
 * all). Two surface shapes are eligible:
 *   - a kana-only surface (で|は → では, さ|は → 左派) — see
 *     {@link kanaSpanTooRareToMerge};
 *   - an `exp` expression entry of any script (雨が降り → 雨が降る,
 *     家を出て → 家を出る) — see {@link hitIsExpression}.
 * A non-expression kanji-bearing surface is never vetoed (高さ stays 高さ). The
 * span's rank is the best (lowest) across each candidate JMdict entry's
 * by-entry rank and the raw surface's own rank.
 *
 * Awaits the (idempotent, cached) frequency-index load and degrades to
 * `false` — never veto a merge — if the index can't be fetched.
 */
async function defaultRareMergeProbe(hit: LookupHit): Promise<boolean> {
  const expression = hitIsExpression(hit);
  // A non-expression kanji-bearing surface is never vetoed; skip the load.
  if (!expression && !isPureKana(hit.surface)) return false;
  try {
    await loadFrequencyIndex();
    let best: number | null = null;
    for (const wr of hit.results) {
      const rank = lookupFrequencyByEntrySync(wr.id)?.rank ?? null;
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
    const surfaceRank = lookupFrequencySync(hit.surface, null).rank;
    if (surfaceRank !== null && (best === null || surfaceRank < best)) {
      best = surfaceRank;
    }
    // An expression is judged on rank alone, kana or kanji-bearing; a plain
    // surface additionally has to be kana-only.
    return expression
      ? rankTooRareToMerge(best)
      : kanaSpanTooRareToMerge(hit.surface, best);
  } catch {
    return false;
  }
}
