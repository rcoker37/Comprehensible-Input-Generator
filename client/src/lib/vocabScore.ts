import { rawScore, SCORE_MULTIPLIER } from "./rarity";
import type { FrequencyTier } from "./frequency";

// Frequency-tier multipliers applied on top of the shared saturating curve
// (see rarity.ts). Common words get a low per-encounter ceiling so they
// reward bulk repetition (idea #2 from the brainstorm) — you'll see them
// hundreds of times and the cumulative total dominates. Rare words get a
// high per-encounter ceiling that saturates fast — meeting one a few times
// and moving on is the realistic curve. Headwords absent from JPDB share
// the very-rare bucket and inherit its multiplier.
export const TIER_MULTIPLIER: Record<FrequencyTier, number> = {
  "very-common": 0.1,
  common: 0.3,
  uncommon: 0.7,
  rare: 1.5,
  "very-rare": 3,
};

export interface VocabEncounter {
  encounters: number;
  tier: FrequencyTier;
}

export function wordScore(count: number, tier: FrequencyTier): number {
  return rawScore(count) * TIER_MULTIPLIER[tier] * SCORE_MULTIPLIER;
}

export function totalVocabScore(
  encounters: Map<string, VocabEncounter>
): number {
  let total = 0;
  for (const { encounters: c, tier } of encounters.values()) {
    total += wordScore(c, tier);
  }
  return total;
}

// Score delta if the user reads this story once: each headword's count
// rises by its raw within-story occurrence count, weighted by its tier.
// Headwords absent from the encounters map are looked up via `resolveTier`
// (typically JPDB) so a never-seen common word predicts at its real
// multiplier instead of the very-rare default — the predicted +X tag must
// match the actual score gain after the read commits and the user-wide
// encounter map refreshes with the headword's true tier.
export function vocabScoreDelta(
  storyOccurrences: Map<string, number>,
  encounters: Map<string, VocabEncounter>,
  resolveTier: (headword: string) => FrequencyTier
): number {
  let delta = 0;
  for (const [headword, occInStory] of storyOccurrences) {
    const cur = encounters.get(headword);
    const tier = cur?.tier ?? resolveTier(headword);
    const count = cur?.encounters ?? 0;
    delta += wordScore(count + occInStory, tier) - wordScore(count, tier);
  }
  return delta;
}
