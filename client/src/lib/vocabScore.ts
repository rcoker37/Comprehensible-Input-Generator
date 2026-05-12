import { rawScore, SCORE_MULTIPLIER } from "./rarity";

// Frequency weighting: a word's contribution to the vocab score is scaled
// by a smooth function of its JPDB rank, so learning common words pays
// more than learning rare ones. The curve is linear in ln(rank), clamped
// at both ends. With the default anchors:
//
//   rank 1        → 3.00  (の／は, the most common words)
//   rank 100      → 1.90  (top everyday vocabulary)
//   rank 1,000    → 1.35  (common)
//   rank 5,000    → 0.96  (mid-common)
//   rank 30,000   → 0.54  (rare)
//   rank 100,000+ → 0.25  (very rare / unranked)
//
// `rank` is null when the headword falls outside the JPDB v2 cap (built
// at rank ≤ 100,000) or isn't in the dict at all — both collapse to the
// floor weight.
const WEIGHT_AT_TOP = 3.0;
const WEIGHT_AT_CAP = 0.25;
const RANK_CAP = 100_000;
const SLOPE = (WEIGHT_AT_TOP - WEIGHT_AT_CAP) / Math.log(RANK_CAP);

export function frequencyWeight(rank: number | null): number {
  if (rank === null) return WEIGHT_AT_CAP;
  const r = rank < 1 ? 1 : rank;
  const w = WEIGHT_AT_TOP - SLOPE * Math.log(r);
  if (w > WEIGHT_AT_TOP) return WEIGHT_AT_TOP;
  if (w < WEIGHT_AT_CAP) return WEIGHT_AT_CAP;
  return w;
}

// Per-word score: the saturating-and-capped exposure curve (see rarity.ts)
// multiplied by the frequency weight, so common words pay more per
// encounter than rare ones at the same count.
export function wordScore(count: number, rank: number | null): number {
  return rawScore(count) * frequencyWeight(rank) * SCORE_MULTIPLIER;
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
