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
  tokenReadingFromAnnotations,
  type FuriganaAnnotation,
} from "./furigana";

const MAX_LOOKUP_LEN = 16;

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
  annotations: FuriganaAnnotation[] = []
): Promise<LookupHit | null> {
  if (offset < 0 || offset >= text.length) return null;

  // Don't scan across script boundaries. In `THCはカンナビス…` a tap on the
  // particle は would otherwise greedily extend to はカン and hit a bogus
  // hiragana-equivalent match (the JMdict IDB normalises katakana→hiragana for
  // its lookup index). hira↔kanji mixes freely (kanji+okurigana, prefix お+
  // kanji); katakana runs stay katakana; ASCII / punctuation stop scanning.
  const scanLimit = scanLengthFromCursor(text, offset);
  const maxLen = Math.min(MAX_LOOKUP_LEN, scanLimit);

  for (let len = maxLen; len >= 1; len--) {
    const prefix = text.slice(offset, offset + len);

    const exact = await lookupWord(prefix);
    if (exact.length > 0) {
      return applyAnnotatedReading(
        { start: offset, end: offset + len, surface: prefix, results: exact },
        annotations
      );
    }

    for (const c of deinflect(prefix)) {
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
  const annotatedReading = tokenReadingFromAnnotations(
    hit.surface,
    hit.start,
    annotations,
    undefined
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
