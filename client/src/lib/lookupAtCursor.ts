// 10ten-style cursor lookup: given a character offset into the story, find the
// longest JMdict match starting at that offset. Falls back to deinflection
// (Yomitan-derived rule set in ./japaneseDeinflect) when the inflected surface
// itself doesn't hit the dictionary — this is what lets a tap on 言って、
// 食べられました、or 飛び出した resolve back to 言う、食べる、飛び出す with
// the conjugation chain surfaced in the popover.

import type { WordResult } from "@birchill/jpdict-idb";
import { deinflect, posMatches, type DeinflectionCandidate } from "./japaneseDeinflect";
import { lookupWord } from "./dictionary";
import { loadFrequencyIndex, lookupFrequencyByEntrySync } from "./frequency";
import {
  surfaceReadingFromAnnotations,
  type FuriganaAnnotation,
} from "./furigana";
import { headwordFromHit } from "./headword";

const MAX_LOOKUP_LEN = 16;

// A deinflection competing with an existing exact match must clear one of two
// bars to be considered (see `firstDeinflectionHit`): it explains at least this
// many surface characters as inflection (いきたい → the -たい rule, consumed 3,
// resolves to いく), OR — when shorter — it is a same-length suffix *swap*
// rather than a lengthening *reduction*. やすく→やすい and により→による swap one
// kana and stay the same length, so they can displace a weak exact match; but
// いき→いきる adds る, and that reduction is too flimsy to outrank the real noun
// 息 (most short kana nouns aren't secretly ichidan stems).
const DEINFLECTION_OVERRIDE_MIN_CONSUMED = 2;

export interface LookupHit {
  /** Inclusive char offset in cleanText where the match starts. */
  start: number;
  /** Exclusive char offset in cleanText where the match ends. */
  end: number;
  /** The raw surface the user tapped (e.g. 食べられました). */
  surface: string;
  /** The deinflected lemma we actually looked up (undefined for exact matches). */
  base?: string;
  /** Ordered derivation chain (e.g. ["passive", "polite", "past"]). */
  derivations?: string[];
  /** JMdict hits — empty when no dictionary entry exists for the tapped span. */
  results: WordResult[];
  /**
   * The LLM-provided reading for this span when it matches one of the JMdict
   * entries' readings — used by the popover to display the disambiguated
   * reading (e.g. にほん rather than にっぽん for 日本《にほん》). Unset when
   * the LLM didn't annotate the span, when no JMdict entry agrees with the
   * annotation, or when the hit was deinflected.
   */
  preferredReading?: string;
}

/**
 * Scan forward from `offset`, trying longer prefixes first, then deinflection
 * candidates at each length, returning the first span that has a dictionary
 * hit. Falls back to a single-character hit with empty results so the popover
 * always has a span to anchor the Explain affordance on.
 *
 * `annotations` are the LLM-provided ruby readings parsed from Aozora notation.
 * When supplied, an exact-match hit is post-processed via `applyAnnotatedReading`
 * so the WordResult whose reading agrees with the LLM is hoisted to the front
 * and surfaced as `preferredReading`.
 */
export async function lookupAtCursor(
  text: string,
  offset: number,
  annotations: FuriganaAnnotation[] = [],
  maxLength?: number
): Promise<LookupHit | null> {
  if (offset < 0 || offset >= text.length) return null;

  // Don't scan across script boundaries. In `THCはカンナビス…` a tap on the
  // particle は would otherwise greedily extend to はカン and hit a bogus
  // hiragana-equivalent match (the JMdict IDB normalises katakana→hiragana for
  // its lookup index). hira↔kanji mixes freely (kanji+okurigana, prefix お+
  // kanji); katakana runs stay katakana; ASCII / punctuation stop scanning.
  // `maxLength`, when supplied, further caps the scan — used by the regroup
  // pass to keep matches inside a single char-run (i.e. not across an
  // annotation boundary).
  const scanLimit = scanLengthFromCursor(text, offset);
  const maxLen = Math.min(
    MAX_LOOKUP_LEN,
    scanLimit,
    maxLength ?? Number.POSITIVE_INFINITY
  );

  for (let len = maxLen; len >= 1; len--) {
    const prefix = text.slice(offset, offset + len);

    const exact = await lookupWord(prefix);
    if (exact.length > 0 && !isKanjiCanonicalKanaMatch(exact, prefix)) {
      return applyAnnotatedReading(
        { start: offset, end: offset + len, surface: prefix, results: exact },
        annotations
      );
    }

    const deinflected = await firstDeinflectionHit(
      prefix,
      exact.length > 0,
      annotations,
      offset
    );

    // The exact match here is pure-kana against a kanji-canonical entry (the
    // branch above didn't fire). Keep it only when JPDB frequency rates it at
    // least as common as the deinflection's lemma — 「のせる」 stays 乗せる
    // instead of the rare potential-form 伸す, while 「いきたい」 still yields
    // to 行く. With no deinflection candidate the exact match is the only
    // answer, and falling through to a shorter span would mangle it.
    if (
      exact.length > 0 &&
      (!deinflected ||
        (await exactOutranksDeinflection(exact, deinflected.results)))
    ) {
      return applyAnnotatedReading(
        { start: offset, end: offset + len, surface: prefix, results: exact },
        annotations
      );
    }

    if (deinflected) {
      return {
        start: offset,
        end: offset + len,
        surface: prefix,
        base: deinflected.base,
        derivations: deinflected.derivations,
        results: deinflected.results,
      };
    }
  }

  // Nothing matched. Return a single-char hit so the popover can still anchor
  // the Explain button + show a "no dictionary entry" status.
  return {
    start: offset,
    end: offset + 1,
    surface: text.slice(offset, offset + 1),
    results: [],
  };
}

/**
 * Single-length lookup at a given span: exact JMdict match first, then
 * deinflection candidates filtered by POS. Used by the regroup pass to test a
 * specific kuromoji-aligned span without iterating shorter lengths.
 *
 * `posHint` is the kuromoji top-level POS for the token starting at `start`,
 * supplied by callers that have tokenizer context (the regroup pass; the
 * popover via a cached re-tokenisation). When kuromoji classifies the span as
 * 動詞 (verb) but the exact JMdict match has no (modern) verb POS — which
 * happens for continuative forms whose surface coincides with an unrelated
 * noun entry, e.g. 「赤くなり、」 → なり (particle) instead of なる, or
 * 「電車に乗り、」 → 乗り (n, "ride") instead of 乗る — we let a deinflection
 * candidate that produces a verb result override the exact match.
 *
 * A second, POS-hint-independent trigger: when the exact match is *only*
 * JMdict `exp` expression entries that JPDB never ranks
 * (`exactIsUnrankedExpression`), a verb deinflection preempts it regardless of
 * what kuromoji tagged the span's leading token. 「見られる」 exact-matches the
 * unranked honorific phrase entry, and resolving it to the verb it conjugates
 * (見る) is the better tap target — but so does 「心をこめて」, which exact-matches
 * the unranked expression 心を込めて while deinflecting to the JPDB-ranked
 * 心を込める; here kuromoji tags the leading token (心) a noun, so gating this
 * on a 動詞 hint would miss it. The unranked-exp gate keeps real, common
 * expression-verbs (which JPDB ranks) returning their own entry untouched.
 * Applies to both pure-kana and mixed-script surfaces.
 *
 * A parallel trigger covers い-adjectives: when kuromoji tags the span 形容詞
 * or 副詞 but the exact JMdict match carries no い-adjective POS, a deinflection
 * that resolves to an `adj-i` base preempts it. 「古くなった」's 古く is the 連用形
 * of 古い, but JMdict also lists a standalone adverb 古く that would otherwise
 * win the exact match — the adjective is the headword every other 古い
 * occurrence groups under. Both POS hints are accepted because kuromoji's
 * IPADIC is inconsistent about adjective 連用形 — 多く tags 形容詞, 古く tags
 * 副詞. The 名詞 hint is excluded, so the noun 多く of 「多くの人」 is left alone.
 *
 * Among the deinflection candidates, the LLM furigana break homophone-stem
 * ties when they cover the span (降《ふ》り → 降る, not 降りる); failing that,
 * `baseHint` — kuromoji's in-context lemma for the span's leading token — picks
 * the candidate kuromoji already resolved to (「〜ていった」 → 行く, not the
 * commoner 言う); only when neither decides is the most common lemma picked by
 * JPDB rank (なって → the everyday なる, not the rare 綯う) — see
 * `pickDeinflection`.
 */
export async function lookupAtBoundary(
  text: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[] = [],
  posHint?: string,
  baseHint?: string
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const prefix = text.slice(start, end);

  const exact = await lookupWord(prefix);

  if (
    (posHint === "動詞" && !hasVerbPos(exact)) ||
    (await exactIsUnrankedExpression(exact)) ||
    (posHint === "動詞" && (await exactIsUnrankedInflectedVerb(exact, prefix)))
  ) {
    const candidates: LookupHit[] = [];
    for (const c of deinflect(prefix)) {
      const hits = await lookupWord(c.base);
      const filtered = filterByPos(hits, c);
      if (filtered.length === 0 || !hasVerbPos(filtered)) continue;
      candidates.push({
        start,
        end,
        surface: prefix,
        base: c.base,
        derivations: c.derivations,
        results: filtered,
      });
    }
    const picked = await pickDeinflection(
      candidates,
      prefix,
      start,
      annotations,
      baseHint
    );
    if (picked) return picked;
  }

  // い-adjective continuative (連用形): 「古くなった」's 古く is the 連用形 of 古い,
  // but JMdict also lists a standalone adverb 古く that exact-matches and would
  // otherwise win. When the exact match has no い-adjective POS and a
  // deinflection resolves to an `adj-i` base, that base preempts it. The gate
  // accepts both kuromoji POS hints an adjective 連用形 surfaces under: 形容詞
  // (多く in 多くなる) and 副詞 — kuromoji's IPADIC lexicalises some 連用形 as
  // standalone adverbs (古く tags 副詞). Excluding the 名詞 hint is what keeps
  // the noun 多く of 多くの人 from being deinflected to 多い.
  if ((posHint === "形容詞" || posHint === "副詞") && !hasAdjPos(exact)) {
    const candidates: LookupHit[] = [];
    for (const c of deinflect(prefix)) {
      const hits = await lookupWord(c.base);
      const filtered = filterByPos(hits, c);
      if (filtered.length === 0 || !hasAdjPos(filtered)) continue;
      candidates.push({
        start,
        end,
        surface: prefix,
        base: c.base,
        derivations: c.derivations,
        results: filtered,
      });
    }
    const picked = await pickDeinflection(
      candidates,
      prefix,
      start,
      annotations,
      baseHint
    );
    if (picked) return picked;
  }

  // A non-kana exact match (kanji or mixed-script) is the word — return it.
  // A pure-kana exact match falls through to be arbitrated against its
  // deinflection by JPDB rank below, even when the entry is `uk` ("usually
  // kana"): a rare uk entry like に因り (rank 22,986) should still yield to the
  // far more common deinflection による (rank 200), while a common uk word
  // out-ranks any deinflection and is kept.
  if (exact.length > 0 && !isPureKana(prefix)) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  // Pure-kana noun/adverb preempt — mirror of the 動詞 branch at the top of
  // this function. When kuromoji confidently tags the span as a non-verb
  // content word AND the exact match carries that POS, the exact match wins
  // before the rank-based deinflection arbitration below has a chance to
  // displace it with a verb. Stops みんな (皆, n+adv) being deinflected to
  // 見る via the "imperative negative slang" rule み+んな — 見る's rank beats
  // 皆's, so `exactRankWins` would pick the verb without this guard. Only
  // fires when kuromoji and JMdict agree on the POS, which keeps cases like
  // 「のせる」 (kuromoji 動詞, exact 乗せる v1, the existing arbitration is
  // correct) on their existing path.
  if (
    exact.length > 0 &&
    exactMatchesNonVerbContentPos(exact, posHint)
  ) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  const deinflected = await firstDeinflectionHit(
    prefix,
    exact.length > 0,
    annotations,
    start
  );

  // A pure-kana exact match that is a JPDB-ranked fixed phrase (exp / conj /
  // int) beats its deinflection on relaxed terms: it doesn't have to *outrank*
  // the lemma, only stay within an order of magnitude of it. JMdict registers
  // the surface as a unitary lexical item with no productive conjugation;
  // once JPDB also ranks it, the phrase entry is a better tap target than the
  // lemma the conjugation rules can produce — unless the lemma is dramatically
  // more common. Mirrors {@link exactIsUnrankedExpression} (an unranked
  // expression loses to deinflection entirely, e.g. 見られる → 見る).
  //
  // The relaxation is what fixes 「そうすれば」 (然うすれば conj, rank 2316) —
  // it stays the conjunction instead of yielding to そうする (rank 815) on
  // exactOutranksDeinflection's strict ≤ comparison. The order-of-magnitude
  // ceiling keeps 「により」 (に因り exp, rank 22986) yielding to the verb に依る
  // (rank 200, ~115× more common) — picking the rare expression there would
  // lose the user a far more useful headword. The ceiling generalises:
  // としても (351) vs とする (60) ≈ 6× → exp; どうしたら (5560) vs unranked
  // どうする → exp.
  if (
    exact.length > 0 &&
    (await expExactBeatsDeinflection(exact, deinflected?.results ?? null))
  ) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  // Pure-kana exact match: kept only when JPDB frequency rates it at least as
  // common as the deinflection's lemma (「のせる」 → 乗せる, not the rare
  // potential-form 伸す), otherwise the deinflection wins (「いきたい」 → 行く,
  // 「により」 → による). No deinflection candidate ⇒ the exact match stands.
  if (
    exact.length > 0 &&
    (!deinflected || (await exactOutranksDeinflection(exact, deinflected.results)))
  ) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  if (deinflected) {
    return {
      start,
      end,
      surface: prefix,
      base: deinflected.base,
      derivations: deinflected.derivations,
      results: deinflected.results,
    };
  }

  const naAdj = await naAdjPrenominalHit(prefix, start, end);
  if (naAdj) return naAdj;

  return null;
}

/**
 * Prenominal form of a na-adjective + the copula's な suffix (静か + な → 静か).
 * JMdict has no entry for this な — it lives entirely inside the copula だ
 * (1517840) — so 「静かな」 exact-matches nothing and 「な」 alone exact-matches
 * the prohibitive particle (2029110, "don't"), neither of which is the word
 * the reader is looking at. Kuromoji tags this な as `助動詞 / basicForm=だ`
 * (the copula auxiliary), and the surface-shape constraint is unambiguous on
 * its own: a span ending in な whose stem JMdict tags `adj-na` is the
 * prenominal form. The regroup pass tries 静か+な as a kuromoji-aligned merge
 * candidate and accepts this hit, so the merged tap target spans 静かな and
 * groups under 静か.
 *
 * Bare な (prefix.length === 1) bypasses this — there is no stem to check —
 * so a standalone prohibitive な (行く + な) still resolves to its own entry.
 * Returns a deinflection-shaped hit so the popover renders the conjugation
 * chain and `headwordFromHit` resolves the headword from the na-adj entry.
 */
async function naAdjPrenominalHit(
  prefix: string,
  start: number,
  end: number
): Promise<LookupHit | null> {
  if (prefix.length < 2 || !prefix.endsWith("な")) return null;
  const stem = prefix.slice(0, -1);
  const stemHits = await lookupWord(stem);
  const naAdjHits = stemHits.filter((wr) =>
    (wr.s ?? []).some((sense) => sense.pos?.includes("adj-na"))
  );
  if (naAdjHits.length === 0) return null;
  return {
    start,
    end,
    surface: prefix,
    base: stem,
    derivations: ["na-adjective"],
    results: naAdjHits,
  };
}

/**
 * Look up exactly the span the regroup pass decided was a tap target. Returns
 * a JMdict hit when one exists; otherwise an empty-results hit so the popover
 * can still anchor against the surface (single-char tap targets like 「が」 in
 * 「があります」 have no JMdict-worthy match longer than 1 char and would
 * previously wander into greedy false positives via lookupAtCursor — e.g.
 * picking up the 「があ」 interjection by extending past the rendered button).
 */
export async function lookupExactSpan(
  text: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[] = [],
  posHint?: string,
  baseHint?: string
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const fromBoundary = await lookupAtBoundary(
    text,
    start,
    end,
    annotations,
    posHint,
    baseHint
  );
  if (fromBoundary) return fromBoundary;
  return {
    start,
    end,
    surface: text.slice(start, end),
    results: [],
  };
}

/**
 * Enumerate every dictionary candidate for a span, used by the manual
 * override UI to let the user pick which JMdict entry should win when the
 * algorithm chose wrong (or to confirm the algorithm's choice).
 *
 * The returned list is the union of:
 *   - every exact JMdict `WordResult` for the surface
 *   - every deinflection candidate whose base has at least one
 *     POS-compatible `WordResult`
 *
 * One `SpanCandidate` per `WordResult` — so a single span that has both
 * homophone entries and a deinflection path produces multiple candidates.
 * Exact matches come first, then deinflections, mirroring
 * `lookupAtBoundary`'s preference order (except for the POS-hint verb
 * preemption, which only affects which one the algorithm auto-picks).
 */
export interface SpanCandidate {
  /** True iff this candidate came from a deinflection rule. */
  deinflected: boolean;
  /** JMdict lemma (the value that lands in `story_word_occurrences.headword`). */
  headword: string;
  /** Primary reading for the lemma, or null when the entry is kana-only. */
  reading: string | null;
  /** Deinflected base form when `deinflected`; otherwise undefined. */
  base?: string;
  /** Conjugation chain (e.g. ["polite", "past"]) when `deinflected`. */
  derivations?: string[];
  /** First sense's glosses joined with "; " — for display in the picker. */
  primarySense: string;
  /** First sense's POS tags. */
  pos: string[];
  /** JMdict entry id (used as a stable React key + tiebreaker). */
  entryId: number;
}

export async function listSpanCandidates(
  text: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[] = []
): Promise<SpanCandidate[]> {
  if (start < 0 || end <= start || end > text.length) return [];
  const surface = text.slice(start, end);
  const out: SpanCandidate[] = [];
  const seenEntryIds = new Set<number>();

  const exact = await lookupWord(surface);
  for (const wr of exact) {
    const synthHit: LookupHit = {
      start,
      end,
      surface,
      results: [wr],
    };
    const annotated = applyAnnotatedReading(synthHit, annotations);
    const hw = headwordFromHit(annotated);
    if (!hw) continue;
    if (seenEntryIds.has(wr.id)) continue;
    seenEntryIds.add(wr.id);
    out.push({
      deinflected: false,
      headword: hw.headword,
      reading: hw.reading,
      primarySense: primarySenseText(wr),
      pos: primarySensePos(wr),
      entryId: wr.id,
    });
  }

  for (const c of deinflect(surface)) {
    const hits = await lookupWord(c.base);
    const filtered = filterByPos(hits, c);
    for (const wr of filtered) {
      if (seenEntryIds.has(wr.id)) continue;
      seenEntryIds.add(wr.id);
      const synthHit: LookupHit = {
        start,
        end,
        surface,
        base: c.base,
        derivations: c.derivations,
        results: [wr],
      };
      const hw = headwordFromHit(synthHit);
      if (!hw) continue;
      out.push({
        deinflected: true,
        headword: hw.headword,
        reading: hw.reading,
        base: c.base,
        derivations: c.derivations,
        primarySense: primarySenseText(wr),
        pos: primarySensePos(wr),
        entryId: wr.id,
      });
    }
  }

  return out;
}

function primarySenseText(wr: WordResult): string {
  const sense = wr.s?.[0];
  if (!sense) return "";
  return sense.g?.map((g) => g.str).join("; ") ?? "";
}

function primarySensePos(wr: WordResult): string[] {
  return wr.s?.[0]?.pos ?? [];
}

/**
 * Re-rank `hit.results` using the LLM-provided reading for the matched span.
 * If any WordResult lists a reading equal to the annotation reading, hoist it
 * to the front and stamp the hit with `preferredReading`. Deinflected hits are
 * returned untouched (the annotation reading describes the inflected surface,
 * not the lemma's r.ent — comparing them would produce false negatives).
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function applyAnnotatedReading(
  hit: LookupHit,
  annotations: FuriganaAnnotation[]
): LookupHit {
  if (hit.base || annotations.length === 0 || hit.results.length === 0) {
    return hit;
  }
  const annotatedReading = surfaceReadingFromAnnotations(
    hit.surface,
    hit.start,
    annotations
  );
  if (!annotatedReading) return hit;

  const matchIdx = hit.results.findIndex((wr) =>
    wr.r?.some((r) => r.ent === annotatedReading)
  );
  if (matchIdx === -1) return hit;

  const results =
    matchIdx === 0
      ? hit.results
      : [
          hit.results[matchIdx]!,
          ...hit.results.slice(0, matchIdx),
          ...hit.results.slice(matchIdx + 1),
        ];
  return { ...hit, results, preferredReading: annotatedReading };
}

/**
 * True when `hit` is an exact (non-deinflected) JMdict match whose surface is
 * fully reading-composable from the LLM's furigana, yet none of the entry's
 * readings equal that composed reading — i.e. the annotations directly rule
 * the entry out. The regroup pass uses this to refuse a merge the furigana
 * contradict: 「今日は」 annotated 今日《きょう》 must not be merged into the
 * greeting こんにちは (whose 今日 reads こんにち).
 *
 * Abstains (returns false) for deinflected hits — the annotation describes the
 * inflected surface, not the lemma — and whenever there is no reading evidence
 * to judge against: no annotation covers the span, the composed reading isn't
 * fully kana (an un-annotated kanji leaked through), or the results carry no
 * readings (e.g. test stand-ins). Pure / no I/O — exposed for unit tests.
 */
export function annotationContradictsHit(
  hit: LookupHit,
  annotations: FuriganaAnnotation[]
): boolean {
  if (hit.base || annotations.length === 0 || hit.results.length === 0) {
    return false;
  }
  const composed = surfaceReadingFromAnnotations(
    hit.surface,
    hit.start,
    annotations
  );
  if (!composed || !isPureKana(composed)) return false;
  const readings = hit.results.flatMap((wr) => wr.r?.map((r) => r.ent) ?? []);
  if (readings.length === 0) return false;
  return !readings.includes(composed);
}

/**
 * True when a deinflection candidate is consistent with the LLM furigana
 * covering `surface`. Disambiguates homophone stems: 降り deinflects to both
 * 降る (ふる) and 降りる (おりる), and a 降《ふ》 ruby fits only 降る.
 *
 * Deinflection rewrites only trailing okurigana, so the surface and the
 * candidate's lemma share their (invariant) kanji stem and differ in a kana
 * suffix. Swapping the surface's suffix for the lemma's inside the
 * annotation-composed surface reading predicts the lemma's reading; the
 * candidate fits when that prediction is one of the lemma's JMdict readings.
 *
 * Abstains (returns true — the caller then keeps `deinflect`'s own priority
 * order) when there is no furigana evidence: no annotation covers the span,
 * the surface suffix isn't kana at the tail of the composed reading, or the
 * lemma carries no readings. Also abstains for `vk` (来る-class irregular)
 * candidates: 来's kanji reading shifts with conjugation (き in 来て, く in
 * 来る, こ in 来ない), so the reverse-prediction above predicts きる for 来る
 * given 来《き》て and incorrectly rejects it. Abstaining lets a competing
 * coincidental fit (like the 連用形 of 来てる, which reads きてる→きて — same
 * kanji reading both ways) get displaced by `baseHint` / rank tiebreakers
 * downstream instead of stealing the verdict. (Other irregulars don't need
 * this: する's kanji form 為 is `sK` and never displays; godan / ichidan
 * kanji readings are invariant under inflection.) Pure / no I/O — exposed for
 * unit tests.
 */
export function deinflectionFitsAnnotations(
  surface: string,
  surfaceStart: number,
  annotations: FuriganaAnnotation[],
  base: string,
  baseResults: WordResult[]
): boolean {
  if (
    baseResults.some((wr) =>
      (wr.s ?? []).some((sense) => sense.pos?.includes("vk"))
    )
  ) {
    return true;
  }
  const surfaceReading = surfaceReadingFromAnnotations(
    surface,
    surfaceStart,
    annotations
  );
  if (!surfaceReading) return true;
  // Common prefix = the kanji stem deinflection leaves untouched.
  let p = 0;
  while (p < surface.length && p < base.length && surface[p] === base[p]) p++;
  const surfaceSuffix = surface.slice(p);
  if (!surfaceReading.endsWith(surfaceSuffix)) return true;
  const predicted =
    surfaceReading.slice(0, surfaceReading.length - surfaceSuffix.length) +
    base.slice(p);
  const readings = baseResults.flatMap((wr) => wr.r?.map((r) => r.ent) ?? []);
  if (readings.length === 0) return true;
  return readings.includes(predicted);
}

type Script = "hira" | "kata" | "kanji" | "other";

function getScript(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x3040 && c <= 0x309f) return "hira";
  // Includes the prolonged-sound mark ー (ー), so カー, カード, etc. don't
  // get split at the mark.
  if (c >= 0x30a0 && c <= 0x30ff) return "kata";
  // Half-width katakana — same word-boundary semantics.
  if (c >= 0xff66 && c <= 0xff9f) return "kata";
  if (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    c === 0x3005 // 々 iteration mark
  )
    return "kanji";
  return "other";
}

export function scanLengthFromCursor(text: string, offset: number): number {
  if (offset >= text.length) return 0;
  const startCh = text[offset];
  if (startCh === undefined) return 0;
  const start = getScript(startCh);
  if (start === "other") return 1;
  const katakanaRun = start === "kata";
  let len = 1;
  while (offset + len < text.length) {
    const ch = text[offset + len];
    if (ch === undefined) break;
    const s = getScript(ch);
    if (s === "other") break;
    if (katakanaRun ? s !== "kata" : s === "kata") break;
    len++;
  }
  return len;
}

/**
 * True when the surface is pure-kana but every candidate `WordResult` is
 * "kanji-canonical" — i.e. the entry has at least one kanji headword and no
 * sense is tagged `uk` ("usually written using kana alone"). The match was
 * therefore on a reading attached to a kanji entry the user is unlikely to
 * have meant by writing kana (e.g. tapping 「いきたい」 returns 生き体 because
 * its reading is いきたい, but no one writes 生き体 in kana).
 *
 * When this is the case, the caller should let a non-trivial deinflection
 * candidate take precedence over the exact match.
 */
export function isKanjiCanonicalKanaMatch(
  results: WordResult[],
  surface: string
): boolean {
  if (!isPureKana(surface)) return false;
  for (const wr of results) {
    if (!wr.k || wr.k.length === 0) return false;
    for (const sense of wr.s) {
      if (sense.misc?.includes("uk")) return false;
    }
  }
  return true;
}

/**
 * True iff any sense's POS tags include an inflecting-verb class (v1/v5/vs/vk/
 * vz and their subtype tags). Excludes `vi`/`vt` which are valence markers, not
 * conjugation classes. Also skips senses tagged `arch` (archaic) or `obs`
 * (obsolete) — classical entries like 也 (なり, the literary copula tagged
 * `aux-v`/`vr`/`cop`) would otherwise satisfy this check and block modern
 * deinflection of 「赤くなり、」 → なる. Used by the kuromoji-POS-hinted
 * deinflection path: if an exact match already contains a modern verb sense,
 * kuromoji's 動詞 hint is already satisfied — no need to override.
 */
export function hasVerbPos(results: WordResult[]): boolean {
  for (const wr of results) {
    for (const sense of wr.s ?? []) {
      if (sense.misc?.some((m) => m === "arch" || m === "obs")) continue;
      for (const tag of sense.pos ?? []) {
        if (tag === "vi" || tag === "vt") continue;
        if (tag[0] === "v") return true;
      }
    }
  }
  return false;
}

/**
 * JMdict POS tags `lookupAtBoundary`'s noun-preempt accepts for each kuromoji
 * hint. The mapping is deliberately narrow:
 *
 *   - 名詞 → `n` and its substructure (`n-suf`/`n-pref`/`n-adv`/`n-t`/`pn`).
 *     Excludes counters (`ctr`) and numerals (`num`) — those have their own
 *     code paths in the indexer (`regroupNumberSpans`).
 *   - 副詞 → `adv`, `adv-to`.
 *
 * 形容詞 / 連体詞 are intentionally absent: an い-adjective 連用形 (古く)
 * tagged 副詞 by kuromoji is already handled by the `adj-i` deinflection branch
 * above, and the rest of the adjective family conjugates productively, so a
 * blanket noun-preempt would steal real adjective lemmas.
 */
const POS_HINT_TO_NON_VERB_CONTENT_POS: Record<string, Set<string>> = {
  "名詞": new Set(["n", "n-suf", "n-pref", "n-adv", "n-t", "pn"]),
  "副詞": new Set(["adv", "adv-to"]),
};

/**
 * True iff `posHint` is one of the non-verb content categories above AND some
 * sense of `exact` carries a JMdict POS in the corresponding tag set. Like
 * {@link hasVerbPos} it skips `arch`/`obs` senses so a classical noun-tagged
 * entry doesn't satisfy a modern 名詞 hint. Used to preempt a verb-
 * deinflection arbitration when kuromoji and JMdict both agree the span is a
 * noun/adverb — the mirror image of the 動詞 preempt at the top of
 * {@link lookupAtBoundary} (mapped onto the pure-kana arbitration path
 * because mixed-script exact matches are already returned unconditionally
 * upstream). Stops みんな (皆, n+adv) being deinflected to 見る via the
 * "imperative negative slang" rule み+んな when kuromoji confidently tags the
 * span 名詞 / 副詞.
 */
export function exactMatchesNonVerbContentPos(
  exact: WordResult[],
  posHint: string | undefined
): boolean {
  if (!posHint) return false;
  const tags = POS_HINT_TO_NON_VERB_CONTENT_POS[posHint];
  if (!tags) return false;
  for (const wr of exact) {
    for (const sense of wr.s ?? []) {
      if (sense.misc?.some((m) => m === "arch" || m === "obs")) continue;
      for (const tag of sense.pos ?? []) {
        if (tags.has(tag)) return true;
      }
    }
  }
  return false;
}

/**
 * True iff any sense's POS tags include an い-adjective class (`adj-i` or the
 * いい/よい special class `adj-ix`). Like {@link hasVerbPos} it skips `arch`/
 * `obs` senses. Used by the kuromoji-形容詞-hinted deinflection path: if an
 * exact match already carries an い-adjective sense, kuromoji's hint is
 * satisfied and no override is needed.
 */
export function hasAdjPos(results: WordResult[]): boolean {
  for (const wr of results) {
    for (const sense of wr.s ?? []) {
      if (sense.misc?.some((m) => m === "arch" || m === "obs")) continue;
      for (const tag of sense.pos ?? []) {
        if (tag === "adj-i" || tag === "adj-ix") return true;
      }
    }
  }
  return false;
}

export function isPureKana(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const hira = c >= 0x3040 && c <= 0x309f;
    const kata = (c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9f);
    if (!hira && !kata) return false;
  }
  return s.length > 0;
}

/**
 * Keeps WordResults whose union of sense POS tags overlaps the candidate's
 * predicted conditions. Without this, an over-eager deinflection rule (e.g.
 * the engine treating ひとり as the masu-stem of a fictitious 一段 verb)
 * would surface a noun entry as if it had been conjugated.
 */
function filterByPos(
  hits: WordResult[],
  candidate: DeinflectionCandidate
): WordResult[] {
  if (candidate.conditions === 0) return hits;
  return hits.filter((wr) => {
    for (const sense of wr.s) {
      if (sense.pos && posMatches(candidate, sense.pos)) return true;
    }
    return false;
  });
}

interface DeinflectionHit {
  base: string;
  derivations: string[];
  results: WordResult[];
}

/**
 * Run the deinflection candidates for `surface` in priority order (consumed
 * descending, as `deinflect` sorts them) and return the first whose base
 * resolves to a POS-compatible JMdict entry. When `hasExact` is true an exact
 * match already exists, so a short lengthening reduction too weak to override
 * it is skipped — see DEINFLECTION_OVERRIDE_MIN_CONSUMED.
 *
 * When the LLM furigana cover the span, a candidate whose lemma reading the
 * ruby fits is preferred over `deinflect`'s priority order — this disambiguates
 * homophone stems like 降り (降る ふり vs 降りる おり). `surfaceStart` locates
 * `surface` in the clean text so `annotations` can be resolved against it.
 */
async function firstDeinflectionHit(
  surface: string,
  hasExact: boolean,
  annotations: FuriganaAnnotation[],
  surfaceStart: number
): Promise<DeinflectionHit | null> {
  let fallback: DeinflectionHit | null = null;
  for (const c of deinflect(surface)) {
    // A short deinflection overrides an exact match only when it swaps a
    // suffix without lengthening (やすく→やすい, により→による); a lengthening
    // reduction (いき→いきる) is too weak — see DEINFLECTION_OVERRIDE_MIN_CONSUMED.
    if (
      hasExact &&
      c.consumed < DEINFLECTION_OVERRIDE_MIN_CONSUMED &&
      c.base.length > surface.length
    ) {
      continue;
    }
    const hits = await lookupWord(c.base);
    const filtered = filterByPos(hits, c);
    if (filtered.length === 0) continue;
    const result: DeinflectionHit = {
      base: c.base,
      derivations: c.derivations,
      results: filtered,
    };
    if (
      deinflectionFitsAnnotations(
        surface,
        surfaceStart,
        annotations,
        c.base,
        filtered
      )
    ) {
      return result;
    }
    fallback ??= result;
  }
  return fallback;
}

/**
 * Best (lowest = most common) JPDB rank across `results`, via the by-entry
 * frequency index. Returns null when none of the entries are ranked — or when
 * the index can't be loaded — so callers treat null as "no frequency signal".
 * Never throws: a failed index fetch degrades to the pre-frequency behaviour.
 */
async function bestRank(results: WordResult[]): Promise<number | null> {
  if (results.length === 0) return null;
  try {
    await loadFrequencyIndex();
    let best: number | null = null;
    for (const wr of results) {
      const rank = lookupFrequencyByEntrySync(wr.id)?.rank;
      if (rank == null) continue;
      if (best === null || rank < best) best = rank;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The hit whose results carry the best (lowest = most common) JPDB rank.
 * Unranked hits lose to any ranked hit; returns null when *every* hit is
 * unranked, so the caller can fall back to `deinflect`'s own priority order.
 */
async function mostCommonHit(hits: LookupHit[]): Promise<LookupHit | null> {
  let best: LookupHit | null = null;
  let bestSeen: number | null = null;
  for (const h of hits) {
    const r = await bestRank(h.results);
    if (r === null) continue;
    if (bestSeen === null || r < bestSeen) {
      bestSeen = r;
      best = h;
    }
  }
  return best;
}

/**
 * True when `lemma` (kuromoji's 基本形 for the span's leading token) names the
 * dictionary form this deinflection candidate resolved to — matching either the
 * deinflection base directly or any kanji / reading form of its JMdict results,
 * so a kana lemma (いく) still matches a kanji-headword entry (行く / いく).
 */
function candidateMatchesLemma(hit: LookupHit, lemma: string): boolean {
  if (hit.base === lemma) return true;
  for (const wr of hit.results) {
    if ((wr.k ?? []).some((k) => k.ent === lemma)) return true;
    if ((wr.r ?? []).some((r) => r.ent === lemma)) return true;
  }
  return false;
}

/**
 * Choose among the deinflection candidates for a kuromoji-動詞 / 形容詞 span.
 *
 * When the LLM furigana cover the span they positively disambiguate homophone
 * stems (降《ふ》り → 降る, not 降りる). The furigana often only cover the kanji
 * (分《わ》かって) — leaving the verb suffix unannotated — so several candidates
 * fit the annotation. Among the fitters, `baseHint` (kuromoji's in-context
 * lemma) picks the candidate kuromoji already resolved to: 分《わ》かって fits
 * both 分かる and 分かつ via the わ ruby, but kuromoji tags it 分かる, so 分かる
 * wins. Similarly 命《めい》じます fits 命じる and 命ずる; baseHint picks 命じる.
 * Only with no furigana evidence — 「〜ていった」's いった is the past of 行く /
 * 言う / 要る alike — does baseHint stand alone (kuromoji tags it 行く, so the
 * JPDB-rank tiebreaker that would take the commoner 言う is overruled). With
 * neither furigana nor usable lemma — pure-kana なって differs only by godan
 * class — the most common lemma wins (なって → the everyday なる, rank 16, not
 * the rare 綯う, 45,193). Falls back to `deinflect`'s priority order when no
 * candidate is ranked. Returns null when there were none.
 */
async function pickDeinflection(
  candidates: LookupHit[],
  surface: string,
  surfaceStart: number,
  annotations: FuriganaAnnotation[],
  baseHint?: string
): Promise<LookupHit | null> {
  if (candidates.length === 0) return null;
  // When the furigana cover the span, narrow to candidates the ruby fits — the
  // annotation can only positively rule lemmas in, never out — but don't return
  // yet: a partial ruby (分《わ》かって) leaves several candidates fitting and the
  // tiebreakers below pick among them.
  const hasAnnot = !!surfaceReadingFromAnnotations(
    surface,
    surfaceStart,
    annotations
  );
  const fitters = hasAnnot
    ? candidates.filter((h) =>
        deinflectionFitsAnnotations(
          surface,
          surfaceStart,
          annotations,
          h.base!,
          h.results
        )
      )
    : candidates;
  const pool = fitters.length > 0 ? fitters : candidates;
  if (baseHint) {
    const fit = pool.find((h) => candidateMatchesLemma(h, baseHint));
    if (fit) return fit;
  }
  return (await mostCommonHit(pool)) ?? pool[0]!;
}

/**
 * True when every exact-match `WordResult` is a JMdict `exp` expression (a
 * multi-word phrase) and JPDB ranks none of them — e.g. 「見られる」 exact-matches
 * only the unranked honorific phrase entry. Such a span conjugates a plain verb
 * (見る) that makes a far better tap target than the phrase, so the POS-hinted
 * verb branch is allowed to run even though the expression entry carries a
 * `v1`/`v5` tag. The unranked gate keeps real, common expression-verbs (which
 * JPDB does rank) returning their own entry untouched.
 */
async function exactIsUnrankedExpression(
  results: WordResult[]
): Promise<boolean> {
  if (results.length === 0) return false;
  const allExpression = results.every((wr) =>
    (wr.s ?? []).some((sense) => sense.pos?.includes("exp"))
  );
  if (!allExpression) return false;
  return (await bestRank(results)) === null;
}

/**
 * Largest rank ratio `(exact / deinflection)` at which a JPDB-ranked
 * fixed-phrase exact match still beats its deinflection. 10× is one order of
 * magnitude — a lemma that's "merely" more common than the fixed phrase
 * (そうする 815 vs 然うすれば 2316 ≈ 2.8×; とする 60 vs としても 351 ≈ 6×)
 * loses to the phrase, but a lemma that's dramatically more common (に依る
 * 200 vs に因り 22986 ≈ 115×) still wins. Tighter (3-5×) would split
 * そうすれば and としても; looser (50-100×) would let に因り capture により.
 */
const FIXED_PHRASE_RANK_RATIO_LIMIT = 10;

/**
 * JMdict POS tags identifying a "fixed phrase" — a surface JMdict registers
 * as a unitary lexical item with no productive conjugation: multi-word
 * `exp`ression, `conj`unction (然うすれば, それから), or `int`erjection
 * (じゃあね, いただきます). All three categories are surfaces the reader
 * encountered as fixed phrases, not as one form of a paradigm — when JMdict
 * lists the surface under these tags AND JPDB ranks it, the phrase entry is a
 * better tap target than whatever lemma the conjugation rules can produce.
 *
 * `prt` (particle) and `adv` (adverb) are deliberately excluded: particles
 * are highly productive (`exactMergeStartsOnFunctionWordIntoKanji` handles
 * particle-led merges separately), and lexicalised adverbs collide with
 * adjective 連用形 — kuromoji tags 古く as 副詞 and JMdict carries a standalone
 * 古く adverb that {@link hasAdjPos} already steers around.
 */
const FIXED_PHRASE_POS = new Set(["exp", "conj", "int"]);

/**
 * True when an exact JMdict match is a JPDB-ranked fixed phrase that should
 * beat the competing deinflection. The phrase entry wins when:
 *
 *   - some sense of some result carries a {@link FIXED_PHRASE_POS} tag,
 *   - that result (or some sibling) is JPDB-ranked, AND
 *   - either the deinflection is unranked, or the phrase's rank is within
 *     {@link FIXED_PHRASE_RANK_RATIO_LIMIT}× of the deinflection's rank.
 *
 * The rank-ratio gate is the load-bearing part: an unconditional "ranked
 * fixed phrase wins" rule would let に因り (rank 22986) capture 「により」
 * away from the much-more-common verb lemma に依る (rank 200). The ratio
 * ceiling keeps the rule firing only when the phrase is "comparable" in
 * commonness — 然うすれば (2316 vs lemma 815 = 2.8×) wins, に因り (22986 vs
 * lemma 200 = 115×) loses.
 *
 * Mirrors {@link exactIsUnrankedExpression} (an unranked exp loses to
 * deinflection entirely, e.g. 見られる → 見る). The test bench covers this
 * via `lookupAtBoundary`; no need to export.
 */
async function expExactBeatsDeinflection(
  exact: WordResult[],
  deinflection: WordResult[] | null
): Promise<boolean> {
  if (exact.length === 0) return false;
  const isFixedPhrase = exact.some((wr) =>
    (wr.s ?? []).some((sense) =>
      sense.pos?.some((tag) => FIXED_PHRASE_POS.has(tag))
    )
  );
  if (!isFixedPhrase) return false;
  const exactRank = await bestRank(exact);
  if (exactRank === null) return false;
  if (!deinflection) return true;
  const deinflectionRank = await bestRank(deinflection);
  if (deinflectionRank === null) return true;
  return exactRank <= deinflectionRank * FIXED_PHRASE_RANK_RATIO_LIMIT;
}

/**
 * True when an exact JMdict match is a JPDB-unranked verb entry that JMdict
 * happens to list an *inflected* form of — i.e. the surface deinflects to a
 * base verb JPDB *does* rank. JMdict carries standalone entries for some
 * productive conjugations (the causative 楽しませる, entry 2743060, unranked)
 * whose conjugated-from lemma (楽しむ, rank 770) is the real tap target and
 * the headword every other occurrence groups under. When this fires the
 * POS-hinted verb branch runs and the deinflection preempts the exact match.
 *
 * Gated three ways so a genuine rare base verb is never deinflected away:
 * every exact result must be a verb, JPDB must rank none of them, and some
 * deinflection must resolve to a *ranked* verb. A plain rare verb (綯う) clears
 * the first two but not the third — it has no ranked lemma underneath it.
 */
async function exactIsUnrankedInflectedVerb(
  results: WordResult[],
  surface: string
): Promise<boolean> {
  if (results.length === 0) return false;
  if (!results.every((wr) => hasVerbPos([wr]))) return false;
  if ((await bestRank(results)) !== null) return false;
  for (const c of deinflect(surface)) {
    if (c.base === surface) continue;
    const hits = filterByPos(await lookupWord(c.base), c);
    if (hits.length === 0 || !hasVerbPos(hits)) continue;
    if ((await bestRank(hits)) !== null) return true;
  }
  return false;
}

/**
 * True when a pure-kana surface's exact match should be kept instead of the
 * competing deinflection. Resolves each side to its best JPDB rank and defers
 * to `exactRankWins` for the arithmetic.
 */
async function exactOutranksDeinflection(
  exact: WordResult[],
  deinflection: WordResult[]
): Promise<boolean> {
  return exactRankWins(await bestRank(exact), await bestRank(deinflection));
}

/**
 * Given each side's best JPDB rank (lower = more common; null = unranked,
 * absent from JPDB, or no frequency data), decide whether a pure-kana exact
 * match beats a competing deinflection:
 *   - exact unranked           → deinflection wins (「いきたい」: the noun 生き体
 *                                 isn't in JPDB, 行く is).
 *   - exact ranked, other null → exact wins (「のせる」: 乗せる is common, the
 *                                 potential-form lemma 伸す isn't ranked).
 *   - both ranked              → the lower rank wins; a tie keeps the exact
 *                                 (non-inflected) reading as the simpler
 *                                 hypothesis.
 *
 * Pure / no I/O — exposed for unit tests.
 */
export function exactRankWins(
  exactRank: number | null,
  deinflectionRank: number | null
): boolean {
  if (exactRank === null) return false;
  if (deinflectionRank === null) return true;
  return exactRank <= deinflectionRank;
}
