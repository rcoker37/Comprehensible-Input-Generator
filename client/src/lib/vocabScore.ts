import { rawScore } from "./rarity";

// Global scale on vocab contributions. There are far more headwords than
// kanji in a typical reader's history, so the unscaled vocab total
// drowns out the kanji total in the header score; dialing vocab back
// keeps the two halves closer to parity.
export const VOCAB_SCALE = 1 / 4;

// Frequency weighting: a word's contribution to the vocab score is scaled
// by a smooth sigmoid in *log* rank, so the weight declines roughly evenly
// across each order of magnitude of rarity. Word frequency is Zipfian —
// rank is a power-law quantity — so a sigmoid in raw rank falls off a
// cliff in the tail (a quadratic-in-rank curve makes everything past
// ~20k worth almost nothing). Working in ln(rank) instead spreads the
// decline so each "10× rarer" band costs a similar amount of weight,
// which matches how vocabulary acquisition actually scales: the long
// tail still pays a meaningful, non-trivial amount.
//
// Shape: `floor + (peak - floor) / (1 + exp(K * (ln(rank) - ln(MID_RANK))))`
// — a logistic centred on MID_RANK, with K the steepness in ln-space.
//
//   rank 1        → 3.99  (の／は, the most common words)
//   rank 1,000    → 3.42
//   rank 5,000    → 2.67
//   rank 10,000   → 2.25  (the midpoint between peak and floor)
//   rank 20,000   → 1.83
//   rank 50,000   → 1.36
//   rank 100,000  → 1.08
//   rank null     → 0.50  (unranked / outside JPDB's 100k cap)
//
// `rank` is null when the headword falls outside the JPDB v2 cap (built
// at rank ≤ 100,000) or isn't in the dict at all — both collapse to the
// floor weight directly. The peak:floor ratio is ≈8× (was ≈27× under the
// old raw-rank curve): common words still clearly outweigh rare ones, but
// rare vocabulary is no longer scored as worthless.
const PEAK_WEIGHT = 4.0;
const FLOOR_WEIGHT = 0.5;
const MID_RANK = 10_000;
const K = 0.7;
const LN_MID_RANK = Math.log(MID_RANK);

export function frequencyWeight(rank: number | null): number {
  if (rank === null) return FLOOR_WEIGHT;
  const r = rank < 1 ? 1 : rank;
  const t = K * (Math.log(r) - LN_MID_RANK);
  return FLOOR_WEIGHT + (PEAK_WEIGHT - FLOOR_WEIGHT) / (1 + Math.exp(t));
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
