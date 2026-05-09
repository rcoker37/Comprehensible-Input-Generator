import { stripAnnotations } from "./furigana";

// Per-kanji raw score caps near ~9.9 (saturating curve up to c=10, slow log
// tail past it). Multiplied by SCORE_MULTIPLIER for display so the headline
// total reads bigger and feels rewarding — reasonable user totals land in
// the tens to low hundreds of thousands.
export const SCORE_MULTIPLIER = 100;

const TAU = 3.5;
const KINK = 10;
const F_KINK = 10 * (1 - Math.exp(-KINK / TAU));
const TAIL_COEF = 0.1;

// f(0) = 0, strictly increasing, diminishing throughout, sharper diminishing
// past KINK, never zero marginal. See PR notes for derivation.
function rawF(c: number): number {
  if (c <= 0) return 0;
  if (c <= KINK) return 10 * (1 - Math.exp(-c / TAU));
  return F_KINK + TAIL_COEF * Math.log(c - KINK + 1);
}

export function kanjiScore(c: number): number {
  return rawF(c) * SCORE_MULTIPLIER;
}

export function totalScore(exposures: Map<string, number>): number {
  let total = 0;
  for (const c of exposures.values()) total += kanjiScore(c);
  return total;
}

// Score delta if the user reads this story once: each kanji's count rises by
// its occurrence count in the story; the contribution shifts from
// kanjiScore(old) to kanjiScore(old + occ). Kanji not in the exposures map
// (i.e. not known) contribute 0 — only known-kanji practice is rewarded.
export function readingScoreDelta(content: string, exposures: Map<string, number>): number {
  const stripped = stripAnnotations(content);
  const occ = new Map<string, number>();
  for (const ch of stripped) {
    if (!exposures.has(ch)) continue;
    occ.set(ch, (occ.get(ch) ?? 0) + 1);
  }
  let delta = 0;
  for (const [ch, n] of occ) {
    const c = exposures.get(ch)!;
    delta += kanjiScore(c + n) - kanjiScore(c);
  }
  return delta;
}

export function readingScoreDeltaPerParagraph(
  content: string,
  exposures: Map<string, number>,
  paragraphs: number,
): number {
  if (paragraphs <= 0) return 0;
  return readingScoreDelta(content, exposures) / paragraphs;
}
