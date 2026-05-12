import { rawScore, SCORE_MULTIPLIER } from "./rarity";

// Per-word score uses the same saturating-and-capped curve as kanji
// (see rarity.ts). No frequency-tier weighting: every headword is treated
// equally so the score rewards breadth of vocabulary rather than rarity.
export function wordScore(count: number): number {
  return rawScore(count) * SCORE_MULTIPLIER;
}

export function totalVocabScore(encounters: Map<string, number>): number {
  let total = 0;
  for (const c of encounters.values()) total += wordScore(c);
  return total;
}

// Score delta if the user reads this story once: each headword's count
// rises by its raw within-story occurrence count.
export function vocabScoreDelta(
  storyOccurrences: Map<string, number>,
  encounters: Map<string, number>
): number {
  let delta = 0;
  for (const [headword, occInStory] of storyOccurrences) {
    const count = encounters.get(headword) ?? 0;
    delta += wordScore(count + occInStory) - wordScore(count);
  }
  return delta;
}
