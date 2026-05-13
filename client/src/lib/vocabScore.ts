import { rawScore } from "./rarity";

// Global scale on vocab contributions. There are far more headwords than
// kanji in a typical reader's history, so the unscaled vocab total
// drowns out the kanji total in the header score; dialing vocab back
// keeps the two halves closer to parity.
export const VOCAB_SCALE = 1 / 2.5;

// Frequency weighting: a word's contribution to the vocab score is scaled
// by a smooth sigmoid in rank, so the "core vocabulary" (top several
// thousand JPDB ranks) all pay near-peak, then the weight drops off as
// rank grows. Shape: `floor + (peak - floor) / (1 + (rank / MID_RANK)^K)`.
//
//   rank 1        → 4.00  (の／は, the most common words)
//   rank 2,000    → 3.85  (still in the plateau)
//   rank 5,000    → 3.23
//   rank 10,000   → 2.08  (the midpoint between peak and floor)
//   rank 20,000   → 0.92
//   rank 50,000   → 0.30
//   rank null     → 0.15  (unranked / outside JPDB's 100k cap)
//
// `rank` is null when the headword falls outside the JPDB v2 cap (built
// at rank ≤ 100,000) or isn't in the dict at all — both collapse to the
// floor weight directly.
const PEAK_WEIGHT = 4.0;
const FLOOR_WEIGHT = 0.15;
const MID_RANK = 10_000;
const K = 2;

export function frequencyWeight(rank: number | null): number {
  if (rank === null) return FLOOR_WEIGHT;
  const r = rank < 1 ? 1 : rank;
  const ratio = r / MID_RANK;
  return FLOOR_WEIGHT + (PEAK_WEIGHT - FLOOR_WEIGHT) / (1 + Math.pow(ratio, K));
}

// Per-word score: the saturating-and-capped exposure curve (see rarity.ts)
// multiplied by the frequency weight and a global vocab scale, so
// common words pay more per encounter than rare ones at the same count.
export function wordScore(count: number, rank: number | null): number {
  return rawScore(count) * frequencyWeight(rank) * VOCAB_SCALE;
}

export type RankLookup = (headword: string) => number | null;

export function totalVocabScore(
  encounters: Map<string, number>,
  getRank: RankLookup
): number {
  let total = 0;
  for (const [headword, count] of encounters) {
    total += wordScore(count, getRank(headword));
  }
  return total;
}

// Score delta if the user reads this story once: each headword's count
// rises by its raw within-story occurrence count.
export function vocabScoreDelta(
  storyOccurrences: Map<string, number>,
  encounters: Map<string, number>,
  getRank: RankLookup
): number {
  let delta = 0;
  for (const [headword, occInStory] of storyOccurrences) {
    const count = encounters.get(headword) ?? 0;
    const rank = getRank(headword);
    delta += wordScore(count + occInStory, rank) - wordScore(count, rank);
  }
  return delta;
}
