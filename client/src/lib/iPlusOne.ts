import { reachRank, WELL_KNOWN_MIN } from "./comprehensibility";
import type { DisplayParagraph } from "./storySegments";
import type { WordOccurrence } from "./storyWordIndex";

type Occurrence = Pick<WordOccurrence, "start" | "end" | "surface" | "headword" | "isName">;

/** Vocabulary estimate using the same known-word and reach rules as story
 * scoring. Learning words also prevent an "everything else familiar" match.
 * Repeated forms of one headword count as a single new word; names are ignored.
 */
export function findIPlusOneSentences(
  paragraphs: DisplayParagraph[],
  occurrences: Occurrence[],
  encounters: Map<string, number>,
  getRank: (headword: string) => number | null,
  frontier: number
): Map<number, string> {
  const result = new Map<number, string>();
  const sorted = [...occurrences].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const sentence of paragraphs.flatMap((p) => p.sentences)) {
    const last = sentence.parts.at(-1);
    if (!last) continue;
    const end = last.kind === "char" ? last.offset + last.char.length : last.end;
    while (cursor < sorted.length && sorted[cursor]!.end <= sentence.start) cursor++;
    let target: string | null = null;
    let eligible = true;
    for (let i = cursor; i < sorted.length && sorted[i]!.start < end; i++) {
      const word = sorted[i]!;
      if (word.start < sentence.start || word.end > end) {
        eligible = false;
        break;
      }
      if (word.isName || !/[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(word.surface)) continue;
      const seen = encounters.get(word.headword) ?? 0;
      const rank = getRank(word.headword);
      if (seen >= WELL_KNOWN_MIN || (rank !== null && rank <= frontier)) continue;
      if (
        !word.headword || seen > 0 || rank === null || rank > reachRank(frontier) ||
        (target !== null && target !== word.headword)
      ) {
        eligible = false;
        break;
      }
      target = word.headword;
    }
    if (eligible && target !== null) result.set(sentence.start, target);
  }
  return result;
}
