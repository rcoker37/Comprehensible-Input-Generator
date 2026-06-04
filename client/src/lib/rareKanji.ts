import type { Kanji } from "../types";

/**
 * The display surfaces of the `limit` rarest-for-this-user kanji within the
 * allowed set. "Rarest" = lowest exposure count first; ties broken by grade
 * descending so higher-grade (i.e. less-elementary) characters are pushed
 * ahead within the same exposure bucket. The third tiebreaker is the character
 * itself so the order is deterministic. Used to nudge the generator and chat
 * prompts toward kanji the reader has seen the least.
 *
 * Exposure missing from the map is treated as 0 — that's how JLPT-N5 baseline
 * characters the user hasn't actually read end up at the front of the list.
 */
export function getTopRareKanji(
  allKanji: Kanji[],
  allowedKanji: Set<string>,
  exposures: Map<string, number>,
  limit: number
): string[] {
  const candidates = allKanji.filter((k) => allowedKanji.has(k.character));
  candidates.sort((a, b) => {
    const ea = exposures.get(a.character) ?? 0;
    const eb = exposures.get(b.character) ?? 0;
    if (ea !== eb) return ea - eb;
    if (a.grade !== b.grade) return b.grade - a.grade;
    return a.character < b.character ? -1 : a.character > b.character ? 1 : 0;
  });
  return candidates.slice(0, limit).map((k) => k.character);
}

/**
 * How many rarely-seen kanji to hand the prompt as a candidate pool. The model
 * is nudged to use a few of them only when they naturally fit the context.
 */
export const RARE_KANJI_POOL_SIZE = 50;
