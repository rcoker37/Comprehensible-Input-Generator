// 10ten-style cursor lookup: given a character offset into the story, find the
// longest JMdict match starting at that offset. Falls back to deinflection
// (Yomitan-derived rule set in ./japaneseDeinflect) when the inflected surface
// itself doesn't hit the dictionary — this is what lets a tap on 言って、
// 食べられました、or 飛び出した resolve back to 言う、食べる、飛び出す with
// the conjugation chain surfaced in the popover.

import type { WordResult } from "@birchill/jpdict-idb";
import { deinflect, posMatches, type DeinflectionCandidate } from "./japaneseDeinflect";
import { lookupWord } from "./dictionary";
import {
  surfaceReadingFromAnnotations,
  type FuriganaAnnotation,
} from "./furigana";

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

    for (const c of deinflect(prefix)) {
      if (exact.length > 0 && c.consumed < DEINFLECTION_OVERRIDE_MIN_CONSUMED) {
        // Exact match exists; only let a substantive deinflection override it.
        continue;
      }
      const hits = await lookupWord(c.base);
      const filtered = filterByPos(hits, c);
      if (filtered.length > 0) {
        return {
          start: offset,
          end: offset + len,
          surface: prefix,
          base: c.base,
          derivations: c.derivations,
          results: filtered,
        };
      }
    }

    // Exact match existed but was kanji-canonical AND no deinflection won —
    // fall back to the exact match rather than letting the loop try a shorter
    // span (which would mangle 「いきたい」 into 「いき」 alone).
    if (exact.length > 0) {
      return applyAnnotatedReading(
        { start: offset, end: offset + len, surface: prefix, results: exact },
        annotations
      );
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
 */
export async function lookupAtBoundary(
  text: string,
  start: number,
  end: number,
  annotations: FuriganaAnnotation[] = []
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const prefix = text.slice(start, end);

  const exact = await lookupWord(prefix);
  if (exact.length > 0 && !isKanjiCanonicalKanaMatch(exact, prefix)) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
  }

  for (const c of deinflect(prefix)) {
    if (exact.length > 0 && c.consumed < DEINFLECTION_OVERRIDE_MIN_CONSUMED) {
      continue;
    }
    const hits = await lookupWord(c.base);
    const filtered = filterByPos(hits, c);
    if (filtered.length > 0) {
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

  if (exact.length > 0) {
    return applyAnnotatedReading(
      { start, end, surface: prefix, results: exact },
      annotations
    );
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
  annotations: FuriganaAnnotation[] = []
): Promise<LookupHit | null> {
  if (start < 0 || end <= start || end > text.length) return null;
  const fromBoundary = await lookupAtBoundary(text, start, end, annotations);
  if (fromBoundary) return fromBoundary;
  return {
    start,
    end,
    surface: text.slice(start, end),
    results: [],
  };
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
