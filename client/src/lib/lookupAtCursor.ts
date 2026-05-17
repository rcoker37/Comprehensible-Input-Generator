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

// When the exact-match path returns an entry whose only-matching headword is
// kana but the entry is "kanji-canonical" (has k forms, no `uk` misc), and a
// deinflection candidate explains at least this many surface characters as
// inflection, prefer the deinflection. Catches いきたい (kanji-only entry
// 生き体, r=いきたい) so it falls through to the -たい rule (consumed=3) and
// resolves to いく. The threshold protects single-char continuative reductions
// like いき→いきる (consumed=1) from outranking a real exact match like 息.
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

    const deinflected = await firstDeinflectionHit(prefix, exact.length > 0);

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
 * candidate that produces a verb result override the exact match. Applies to
 * both pure-kana and mixed-script surfaces; the only gate is the POS hint
 * plus the absence of a modern verb POS in the exact match.
 */
export async function lookupAtBoundary(
  text: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[] = [],
  posHint?: string
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const prefix = text.slice(start, end);

  const exact = await lookupWord(prefix);

  if (posHint === "動詞" && !hasVerbPos(exact)) {
    for (const c of deinflect(prefix)) {
      const hits = await lookupWord(c.base);
      const filtered = filterByPos(hits, c);
      if (filtered.length > 0 && hasVerbPos(filtered)) {
        return {
          start,
          end,
          surface: prefix,
          base: c.base,
          derivations: c.derivations,
          results: filtered,
        };
      }
    }
  }

  if (exact.length > 0 && !isKanjiCanonicalKanaMatch(exact, prefix)) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  const deinflected = await firstDeinflectionHit(prefix, exact.length > 0);

  // Pure-kana exact match against a kanji-canonical entry: kept only when
  // JPDB frequency rates it at least as common as the deinflection's lemma
  // (「のせる」 → 乗せる, not the rare potential-form 伸す), otherwise the
  // deinflection wins (「いきたい」 → 行く). No deinflection candidate ⇒ the
  // exact match stands.
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

  return null;
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
  posHint?: string
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const fromBoundary = await lookupAtBoundary(
    text,
    start,
    end,
    annotations,
    posHint
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

function isPureKana(s: string): boolean {
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
 * match already exists, so only deinflections substantial enough to override
 * it (consumed ≥ DEINFLECTION_OVERRIDE_MIN_CONSUMED) are considered.
 */
async function firstDeinflectionHit(
  surface: string,
  hasExact: boolean
): Promise<DeinflectionHit | null> {
  for (const c of deinflect(surface)) {
    if (hasExact && c.consumed < DEINFLECTION_OVERRIDE_MIN_CONSUMED) continue;
    const hits = await lookupWord(c.base);
    const filtered = filterByPos(hits, c);
    if (filtered.length > 0) {
      return { base: c.base, derivations: c.derivations, results: filtered };
    }
  }
  return null;
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
