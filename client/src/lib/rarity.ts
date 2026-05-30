import { stripAnnotations } from "./furigana";
import { KANJI_REGEX } from "./constants";

// Per-exposure raw score saturates near ~9.43 (the curve's value at c=10)
// and is hard-capped there: further encounters of the same kanji/word
// contribute nothing. SCORE_MULTIPLIER scales the kanji curve before
// display. `vocabScore.ts` reuses the same `rawScore` shape but scales
// independently (see VOCAB_SCALE).
export const SCORE_MULTIPLIER = 1;

const TAU = 3.5;
const KINK = 10;
const F_KINK = 10 * (1 - Math.exp(-KINK / TAU));

// f(0) = 0, strictly increasing on [0, KINK], saturated past KINK.
export function rawScore(c: number): number {
  if (c <= 0) return 0;
  if (c >= KINK) return F_KINK;
  return 10 * (1 - Math.exp(-c / TAU));
}

export function kanjiScore(c: number): number {
  return rawScore(c) * SCORE_MULTIPLIER;
}

export function totalScore(exposures: Map<string, number>): number {
  let total = 0;
  for (const c of exposures.values()) total += kanjiScore(c);
  return total;
}

// Score delta from a precomputed (kanji → occurrences in this read) map.
// Each kanji's stored exposure count rises by its occurrence count; the
// contribution shifts from kanjiScore(old) to kanjiScore(old + occ).
// Unseen kanji (not in the exposures map) start from 0. Used by chats
// (where the kanji counts arrive aggregated server-side via
// get_per_chat_payout) and by readingScoreDelta (which extracts the
// counts from story text).
export function kanjiCountsDelta(
  counts: Map<string, number>,
  exposures: Map<string, number>,
): number {
  let delta = 0;
  for (const [ch, n] of counts) {
    const c = exposures.get(ch) ?? 0;
    delta += kanjiScore(c + n) - kanjiScore(c);
  }
  return delta;
}

// Story-content variant of kanjiCountsDelta: extracts per-kanji counts
// from the cleaned content text before scoring.
export function readingScoreDelta(content: string, exposures: Map<string, number>): number {
  const stripped = stripAnnotations(content);
  const occ = new Map<string, number>();
  for (const ch of stripped) {
    if (!KANJI_REGEX.test(ch)) continue;
    occ.set(ch, (occ.get(ch) ?? 0) + 1);
  }
  return kanjiCountsDelta(occ, exposures);
}

// Display formatter: any score below 1 collapses to "0"; otherwise a
// locale-formatted integer. Never shows decimals.
export function formatScore(score: number): string {
  if (score < 1) return "0";
  return Math.round(score).toLocaleString();
}
