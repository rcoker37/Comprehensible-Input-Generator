// Adapter that wraps the generic LanguageTransformer with Yomitan's Japanese
// rule set and exposes a small API for `lookupAtCursor`. The transformer is
// a singleton so the per-call cost is just the BFS, not engine setup.

import { LanguageTransformer } from "./languageTransformer";
import { japaneseTransforms } from "./japaneseTransforms";

const transformer = new LanguageTransformer();
transformer.addDescriptor(japaneseTransforms);

export interface DeinflectionCandidate {
  /** Dictionary form the engine reduced the surface to. */
  base: string;
  /**
   * Ordered chain of transform names from outermost (closest to surface) to
   * innermost (closest to the dictionary form). Matches what the popover
   * already renders, e.g. ["polite", "past"].
   */
  derivations: string[];
  /**
   * Bitfield of grammatical categories the candidate must satisfy in the
   * dictionary entry's POS tags (e.g. v1, v5k, adj-i). Used by `posMatches`
   * below to filter out wrong-class deinflections that happen to match the
   * surface regex (e.g. ひとり deinflecting to a fictitious verb ひとる).
   */
  conditions: number;
}

/**
 * Returns every dictionary-form candidate the engine can derive from
 * `surface`, excluding the surface itself. Order is BFS discovery order, so
 * shorter chains come first — callers should still try each candidate against
 * the dictionary and accept the first hit.
 */
export function deinflect(surface: string): DeinflectionCandidate[] {
  const candidates = transformer.transform(surface);
  const out: DeinflectionCandidate[] = [];
  for (const c of candidates) {
    if (c.text === surface) continue;
    out.push({
      base: c.text,
      derivations: c.trace.map((frame) => frame.transform),
      conditions: c.conditions,
    });
  }
  return out;
}

// JMdict's POS tags split godan verbs by row (v5k, v5g, …) and ichidan into
// just `v1`, while Yomitan's transforms only know about umbrella categories
// (v5, v1) and a "dictionary form" leaf flag (v5d, v1d). When we ask whether
// a JMdict entry's POS satisfies a deinflection's predicted conditions, the
// row-level tags need to be collapsed onto the leaf Yomitan recognizes. Tags
// not listed here (e.g. `n`, `adv`, `vt`, `vi`) deliberately pass through
// unchanged so they contribute 0 — they're not inflectable classes.
const JMDICT_TO_YOMITAN: Record<string, string> = {
  // Godan rows → "godan dictionary form".
  "v5k": "v5d",
  "v5g": "v5d",
  "v5s": "v5d",
  "v5t": "v5d",
  "v5n": "v5d",
  "v5b": "v5d",
  "v5m": "v5d",
  "v5r": "v5d",
  "v5u": "v5d",
  "v5k-s": "v5d", // 行く, 逝く, 往く
  "v5r-i": "v5d", // ある (irregular)
  "v5aru": "v5d", // いらっしゃる, ござる, etc.
  "v5u-s": "v5d", // 請う, 問う, etc.
  // Ichidan and its variants → "ichidan dictionary form".
  "v1": "v1d",
  "v1-s": "v1d", // くれる-class
  // Adjective i-shi alias.
  "adj-ix": "adj-i",
  // Suru subclasses.
  "vs-i": "vs",
  "vs-s": "vs",
};

/**
 * Translates JMdict POS tag strings into the engine's condition bitfield.
 * Unknown tags contribute 0 (they're benign — verbs/adjectives carry tags we
 * recognize, while non-inflecting tags like `n`/`adv`/`exp` simply don't gate).
 */
export function posTagsToConditions(tags: string[]): number {
  let flags = 0;
  for (const tag of tags) {
    const remapped = JMDICT_TO_YOMITAN[tag] ?? tag;
    flags |= transformer.getConditionFlag(remapped);
  }
  return flags;
}

/**
 * True iff the candidate's predicted POS overlaps with any of the tags. If
 * the candidate's `conditions` is 0 (defensive — shouldn't happen for derived
 * candidates) we accept unconditionally.
 */
export function posMatches(
  candidate: DeinflectionCandidate,
  tags: string[]
): boolean {
  if (candidate.conditions === 0) return true;
  return (posTagsToConditions(tags) & candidate.conditions) !== 0;
}
