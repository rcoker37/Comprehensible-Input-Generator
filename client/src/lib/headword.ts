// Pure helper that derives the canonical headword (and its primary reading)
// from a LookupHit so word_lookups can group conjugations under a single key.
//
// Precedence (identical for exact-match and deinflected hits):
//   1. first non-`sK` primary.k entry — `sK` is JMdict's "search-only kanji"
//      tag (the form exists for matching but must never be displayed). With-
//      out this filter the の particle's entry, whose only kanji forms are 乃
//      and 之 — both `sK` — would stamp `乃` as the canonical headword on
//      every occurrence of の.
//   2. primary.r[0].ent — kana-only entries (e.g. ありがとう), or entries
//      where every kanji form is `sK`.
//   3. hit.base — only as a last resort, when a deinflected hit somehow has
//      no JMdict results to derive a canonical form from.
//
// A deinflected hit must NOT just return `hit.base`: the deinflection base is
// whatever script the surface deinflected *to* (います → the kana base いる),
// but the entry's canonical form is 居る. Stamping the kana base splits
// encounter counts — an exact 居る/いる tap stamps 居る while a conjugated
// います stamps いる — so the Stats Browse card (keyed on the entry's
// `canonical`, which is jpdb-by-entry's first-non-sK-kanji surface) under-
// counts. Both branches resolve through `hit.results[0]`, which is also the
// entry the indexer stamps as `entry_id`, so the headword always agrees with
// the entry id.
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
  const primary = hit.results[0];

  // A deinflected hit still derives its headword from the resolved entry's
  // canonical kanji form — falling back to hit.base only when the entry has
  // no displayable form at all.
  if (hit.base) {
    const displayKanji = primary?.k?.find((k) => !k.i?.includes("sK"));
    const headword = displayKanji?.ent ?? primary?.r?.[0]?.ent ?? hit.base;
    return {
      headword,
      reading: primary?.r?.[0]?.ent ?? null,
    };
  }

  if (!primary) return null;

  const displayKanji = primary.k?.find((k) => !k.i?.includes("sK"));
  const headword = displayKanji?.ent ?? primary.r?.[0]?.ent;
  if (!headword) return null;

  return {
    headword,
    reading: hit.preferredReading ?? primary.r?.[0]?.ent ?? null,
  };
}
