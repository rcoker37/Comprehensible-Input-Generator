// 10ten-style cursor lookup: given a character offset into the story, find the
// longest JMdict match starting at that offset. Falls back to deinflection
// (jp-verbs, MIT-licensed) when the inflected surface itself doesn't hit the
// dictionary — this is what lets a tap on 言って、食べられました、or 飛び出した
// resolve back to 言う、食べる、飛び出す with the conjugation chain surfaced
// in the popover. Independent of 10ten's GPL source.

import type { WordResult } from "@birchill/jpdict-idb";
import * as jpVerbs from "jp-verbs";
import { lookupWord } from "./dictionary";

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
  /** Ordered derivation chain from jp-verbs (e.g. ["passive", "polite", "past"]). */
  derivations?: string[];
  /** JMdict hits — empty when no dictionary entry exists for the tapped span. */
  results: WordResult[];
}

interface JpVerbsCandidate {
  base: string;
  derivationSequence: { derivations: string[] };
}

/**
 * Scan forward from `offset`, trying longer prefixes first, then deinflection
 * candidates at each length, returning the first span that has a dictionary
 * hit. Falls back to a single-character hit with empty results so the popover
 * always has a span to anchor the Explain affordance on.
 */
export async function lookupAtCursor(
  text: string,
  offset: number
): Promise<LookupHit | null> {
  if (offset < 0 || offset >= text.length) return null;

  const maxLen = Math.min(MAX_LOOKUP_LEN, text.length - offset);

  for (let len = maxLen; len >= 1; len--) {
    const prefix = text.slice(offset, offset + len);

    const exact = await lookupWord(prefix);
    if (exact.length > 0) {
      return { start: offset, end: offset + len, surface: prefix, results: exact };
    }

    let candidates: JpVerbsCandidate[] = [];
    try {
      candidates = jpVerbs.unconjugate(prefix) as JpVerbsCandidate[];
    } catch {
      // jp-verbs occasionally throws on inputs its rule set can't handle;
      // treat as no deinflection candidates and fall through to shorter len.
    }

    for (const c of candidates) {
      if (!c?.base || c.base === prefix) continue;
      const hits = await lookupWord(c.base);
      if (hits.length > 0) {
        return {
          start: offset,
          end: offset + len,
          surface: prefix,
          base: c.base,
          derivations: c.derivationSequence?.derivations ?? [],
          results: hits,
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
