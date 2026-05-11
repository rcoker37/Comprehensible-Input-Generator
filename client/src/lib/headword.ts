// Pure helper that derives the canonical headword (and its primary reading)
// from a LookupHit so word_lookups can group conjugations under a single key.
//
// Precedence:
//   1. hit.base — when the lookup deinflected, the base form is the JMdict
//      entry we successfully looked up. Always the right answer.
//   2. primary.k[0].ent — for exact matches with kanji forms (e.g. 日本).
//   3. primary.r[0].ent — for kana-only entries (e.g. ありがとう).
//
// Returns null when the hit has neither a deinflection base nor any JMdict
// results — i.e. a 1-char "no entry" fallback the popover surfaces but isn't
// worth recording in lookup history.

import type { LookupHit } from "./lookupAtCursor";

export interface Headword {
  headword: string;
  reading: string | null;
}

export function headwordFromHit(hit: LookupHit): Headword | null {
  if (hit.base) {
    const primary = hit.results[0];
    return {
      headword: hit.base,
      reading: primary?.r?.[0]?.ent ?? null,
    };
  }

  const primary = hit.results[0];
  if (!primary) return null;

  const headword = primary.k?.[0]?.ent ?? primary.r?.[0]?.ent;
  if (!headword) return null;

  return {
    headword,
    reading: hit.preferredReading ?? primary.r?.[0]?.ent ?? null,
  };
}
