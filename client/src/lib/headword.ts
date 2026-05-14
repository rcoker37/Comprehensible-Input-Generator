// Pure helper that derives the canonical headword (and its primary reading)
// from a LookupHit so word_lookups can group conjugations under a single key.
//
// Precedence:
//   1. hit.base — when the lookup deinflected, the base form is the JMdict
//      entry we successfully looked up. Always the right answer.
//   2. first non-`sK` primary.k entry — `sK` is JMdict's "search-only kanji"
//      tag (the form exists for matching but must never be displayed). With-
//      out this filter the の particle's entry, whose only kanji forms are 乃
//      and 之 — both `sK` — would stamp `乃` as the canonical headword on
//      every occurrence of の.
//   3. primary.r[0].ent — kana-only entries (e.g. ありがとう), or entries
//      where every kanji form is `sK`.
//
// The same precedence drives `canonical` in jpdb-by-entry.json so a stamped
// headword round-trips back to its entry via `lookupFrequencyByCanonicalSync`.
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

  const displayKanji = primary.k?.find((k) => !k.i?.includes("sK"));
  const headword = displayKanji?.ent ?? primary.r?.[0]?.ent;
  if (!headword) return null;

  return {
    headword,
    reading: hit.preferredReading ?? primary.r?.[0]?.ent ?? null,
  };
}
