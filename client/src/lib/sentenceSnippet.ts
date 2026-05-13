// Extracts the sentence containing a span so the word popover's "other usages"
// carousel can render each prior usage in its sentence context. Reuses
// `buildDisplaySegments` so sentence boundaries match the story renderer
// exactly (terminators 。！？ optionally followed by closer chars, blank lines
// for paragraph breaks).
//
// Returns the sentence's text plus the annotations (ruby readings) within it,
// with annotation offsets rebased to the snippet so consumers can render them
// directly. Surface offsets are likewise rebased so the renderer can wrap the
// span in a highlight without recomputing global offsets.

import { buildDisplaySegments, type SegmentPart } from "./storySegments";
import type { FuriganaAnnotation } from "./furigana";

export interface SentenceSnippet {
  /** The sentence text — `cleanText.slice(sentenceStart, sentenceEnd)`. */
  text: string;
  /** Annotations within the sentence, with offsets relative to `text`. */
  annotations: FuriganaAnnotation[];
  /** Surface highlight start, relative to `text`. */
  surfaceStart: number;
  /** Surface highlight end (exclusive), relative to `text`. */
  surfaceEnd: number;
  /** Absolute start offset of the sentence in the source `cleanText`. */
  sentenceStart: number;
  /** Absolute end offset of the sentence (exclusive) in the source `cleanText`. */
  sentenceEnd: number;
}

function partEnd(part: SegmentPart): number {
  if (part.kind === "char") return part.offset + 1;
  return part.end;
}

function partStart(part: SegmentPart): number {
  if (part.kind === "char") return part.offset;
  return part.start;
}

/**
 * Find the sentence containing the span and slice it out with rebased
 * annotations + highlight offsets. Returns `null` if no sentence is found
 * (span out of range, or empty text).
 */
export function extractSentenceSnippet(
  cleanText: string,
  annotations: FuriganaAnnotation[],
  start: number,
  end: number
): SentenceSnippet | null {
  if (start < 0 || end <= start || end > cleanText.length) return null;

  const paragraphs = buildDisplaySegments(cleanText, annotations);
  for (const para of paragraphs) {
    for (const sentence of para.sentences) {
      if (sentence.parts.length === 0) continue;
      const lastPart = sentence.parts[sentence.parts.length - 1]!;
      const firstPart = sentence.parts[0]!;
      const sStart = Math.min(sentence.start, partStart(firstPart));
      const sEnd = partEnd(lastPart);
      if (start >= sStart && start < sEnd) {
        const clamped = {
          start: Math.max(start, sStart),
          end: Math.min(end, sEnd),
        };
        return {
          text: cleanText.slice(sStart, sEnd),
          annotations: annotations
            .filter((a) => a.start >= sStart && a.end <= sEnd)
            .map((a) => ({
              start: a.start - sStart,
              end: a.end - sStart,
              reading: a.reading,
            })),
          surfaceStart: clamped.start - sStart,
          surfaceEnd: clamped.end - sStart,
          sentenceStart: sStart,
          sentenceEnd: sEnd,
        };
      }
    }
  }
  return null;
}
