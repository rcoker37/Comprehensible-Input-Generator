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
// One more guard runs the other way. JMdict carries entries for kana runs
// that aren't the word the reader is looking at — particle runs like では and
// これは, and reading coincidences like さは (which exact-matches 左派, "left
// wing"). When kuromoji splits で|は or さ|は the alignment rule would happily
// merge them back into that JMdict entry. So a merge is also refused when
// it's an exact match, it crosses a kuromoji boundary, the merged surface is
// kana-only, and JPDB ranks it no better than the very-rare tier (or not at
// all) — see `rareKanaMergeProbe`. JPDB ranks lexicalised compound particles
// well (には 22, とは 71) so those keep merging; 左派 sits at 62,243 so さ|は
// stays split. The kana-only gate is also what lets a kanji compound JPDB
// happens not to list — 高さ, which JPDB folds into the adjective 高い —
// merge anyway: the rare-merge veto never touches a kanji-bearing surface.
//
// That rank veto only covers exact matches; a parallel guard catches the
// deinflection version. 「外はもう…」 splits は|もう, but JMdict deinflects
// 「はもう」 to the volitional of the rare verb 食む (はむ) — and 食む sits at
// rank 25,527, inside the `rare` tier, so the rank veto would let it through.
// A deinflection chain can only *start* on a content word, though, so a merge
// is also refused when it's a deinflection that crosses a kuromoji boundary
// and kuromoji tagged its leading token as a particle — see
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
import { tokenizeText, type KuromojiTokenInfo } from "./tokenizer";
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
 * A merge-veto probe. Given a candidate exact-match hit, returns true to
 * refuse the merge. Injectable so tests can drive the veto deterministically
 * without real frequency data; production uses {@link rareKanaMergeProbe}.
 */
export type RareMergeProbe = (hit: LookupHit) => boolean | Promise<boolean>;

export async function regroupWords(
  paragraphs: DisplayParagraph[],
  cleanText: string,
  annotations: FuriganaAnnotation[],
  lookup: LookupAtBoundaryFn = lookupAtBoundary,
  tokenize: TokenizeFn = tokenizeText,
  rareMergeProbe: RareMergeProbe = rareKanaMergeProbe
): Promise<DisplayParagraph[]> {
  const tokens = await tokenize(cleanText);
  const boundaries = tokens.map((t) => t.end); // sorted ascending by construction

  // Boundaries that land between a content verb (動詞) and a trailing
  // auxiliary (助動詞). A merge ending exactly here would orphan the
  // aux from its stem — e.g. 「に|し|ます」 has end=2 (after し), which
  // matches JMdict's 「にし」 (西=west) by surface alone but is wrong in
  // context. Pass 1 still tries the longer span (which deinflects via the
  // polite ます rule), so 「あります」「食べました」 keep working; only the
  // orphan-the-aux case is rejected.
  const auxAfterVerbBoundaries = new Set<number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const cur = tokens[i]!;
    const next = tokens[i + 1]!;
    if (cur.pos === "動詞" && next.pos === "助動詞") {
      auxAfterVerbBoundaries.add(cur.end);
    }
  }

  // Per-token POS keyed by token start offset. Passed to lookupAtBoundary so
  // it can disambiguate cases like 「赤くなり、」 where kuromoji says なり is
  // 動詞 (continuative of なる) but JMdict has an unrelated noun entry that
  // would otherwise short-circuit deinflection.
  const posByStart = new Map<number, string>();
  for (const tok of tokens) posByStart.set(tok.start, tok.pos);

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
        auxAfterVerbBoundaries,
        posByStart,
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
  auxAfterVerbBoundaries: Set<number>,
  posByStart: Map<number, string>,
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
      const hit = await lookup(cleanText, start, b, annotations, posByStart.get(start));
      // Reject a hit whose entry reading the LLM furigana contradict — e.g.
      // 今日《きょう》は must not merge into the greeting こんにちは.
      if (!hit || annotationContradictsHit(hit, annotations)) continue;
      // Refuse a merge that glues a kuromoji-split span into a JMdict entry
      // JPDB has never ranked as a word: で|は → では, これ|は → これは.
      // Kuromoji already draws the right boundary in context (and keeps a
      // genuine sentence-initial では conjunction as one token), so deferring
      // to its split is safe. Exact matches only — a deinflection chain like
      // 食べ|まし|た → 食べました must still merge.
      if (
        !hit.base &&
        crossesKuromojiBoundary(start, b, boundaries) &&
        (await rareMergeProbe(hit))
      ) {
        continue;
      }
      // Refuse a deinflection merge whose leading kuromoji token is a
      // particle: a verb/adjective conjugation can't begin on one. 「は|もう」
      // would otherwise deinflect to the volitional of the rare verb 食む.
      if (
        crossesKuromojiBoundary(start, b, boundaries) &&
        deinflectionMergeStartsOnParticle(hit, posByStart.get(start))
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
        const hit = await lookup(cleanText, start, b, annotations, posByStart.get(start));
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

/**
 * Veto decision for the deinflection counterpart of the rare-kana-merge guard:
 * should a kuromoji-split deinflection merge be refused, given the candidate
 * `hit` and the kuromoji POS of the span's leading token?
 *
 * A deinflection chain (食べ|まし|た → 食べる) is a conjugated verb or
 * adjective, so it can only *start* on a content word. When kuromoji tags the
 * leading token as a particle, the "deinflection" is a coincidence — は|もう
 * deinflects to the volitional of the rare verb 食む — and the merge is wrong.
 * Exact matches are out of scope here (they have their own rank-based veto and
 * cover lexicalised compound particles like には); only `hit.base` hits apply.
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
 * Rank ceiling for the kana-merge veto. A kana-only merged span whose best
 * JPDB rank is worse than this — or unranked entirely — is treated as too
 * rare to be the word the reader is looking at. 30,000 is the `rare` /
 * `very-rare` tier boundary (see `rankToTier`): 左派 (さは) sits at 62,243 so
 * さ|は stays split, while JPDB-ranked compound particles には (22) / とは (71)
 * clear it comfortably and keep merging.
 */
export const RARE_KANA_MERGE_MAX_RANK = 30_000;

/**
 * Pure veto decision for {@link rareKanaMergeProbe}: should a kuromoji-split
 * exact-match merge be refused, given the merged `surface` and its best known
 * JPDB `rank` (null = unranked / absent from JPDB)?
 *
 * Only kana-only surfaces are eligible. A surface containing a kanji is a word
 * the LLM deliberately wrote and JMdict exact-matched, so it always merges —
 * this is what keeps 高《たか》さ → 高さ working even though JPDB has no entry
 * for 高さ at all (JPDB folds it into the adjective 高い, just as kuromoji tags
 * 高 as 形容詞 + さ as 接尾辞). Among kana-only surfaces, the merge is refused
 * when the span is unranked or ranked no better than the very-rare tier — a
 * reading coincidence like さ|は = 左派, or a particle run like で|は = では,
 * is not the word the reader is looking at.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function kanaSpanTooRareToMerge(
  surface: string,
  rank: number | null
): boolean {
  if (!isPureKana(surface)) return false;
  return rank === null || rank > RARE_KANA_MERGE_MAX_RANK;
}

/**
 * The default {@link RareMergeProbe}. Vetoes a kuromoji-split exact merge when
 * its surface is kana-only and JPDB ranks it no better than the very-rare tier
 * (or not at all) — see {@link kanaSpanTooRareToMerge}. The span's rank is the
 * best (lowest) across each candidate JMdict entry's by-entry rank and the raw
 * surface's own rank.
 *
 * Awaits the (idempotent, cached) frequency-index load and degrades to
 * `false` — never veto a merge — if the index can't be fetched.
 */
async function rareKanaMergeProbe(hit: LookupHit): Promise<boolean> {
  // Kanji-bearing surfaces are never vetoed; skip the index load for them.
  if (!isPureKana(hit.surface)) return false;
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
    return kanaSpanTooRareToMerge(hit.surface, best);
  } catch {
    return false;
  }
}
