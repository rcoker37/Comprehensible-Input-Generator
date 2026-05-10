// Walks (cleanText, annotations) and produces a paragraph/sentence/part
// structure where every character is its own clickable unit (and every
// annotated kanji block is a single unit).
//
// Sentence boundaries: 。！？ followed by any closer characters (」』）"’).
// Paragraph boundaries: blank line (two or more newlines).
// Single newlines start a new sentence within the same paragraph.
//
// Whitespace runs are not emitted as parts — they only drive paragraph and
// sentence transitions. Annotation surfaces are emitted as a single
// "annotated" part. Every other character is emitted as its own "char" part,
// so a tap maps 1:1 to the character the user pointed at.

import type { FuriganaAnnotation } from "./furigana";

export const SENTENCE_TERMINATORS = new Set(["。", "！", "？"]);
export const SENTENCE_CLOSERS = new Set(["」", "』", "）", ")", "”", "’"]);

export interface AnnotatedPart {
  kind: "annotated";
  start: number;
  end: number;
  surface: string;
  reading: string;
}

export interface CharPart {
  kind: "char";
  offset: number;
  char: string;
}

/**
 * A span the regroup pass merged into one tap target. Emitted by
 * `regroupWords`; the sync `buildDisplaySegments` only ever produces
 * `CharPart`s and `AnnotatedPart`s. Tap handlers pass `(start, end)` to
 * `lookupExactSpan`, so any tap inside the visual word resolves to the same
 * dictionary entry.
 */
export interface WordPart {
  kind: "word";
  /** Inclusive char offset in the input text where this word begins. */
  start: number;
  /** Exclusive char offset in the input text where this word ends. */
  end: number;
  /** Surface form: `cleanText.slice(start, end)`. */
  surface: string;
  /**
   * Sub-annotations within (start, end). Set when the regroup merge crossed
   * one or more `AnnotatedPart`s — the LLM-supplied per-kanji ruby readings
   * for the kanji inside the merged span. Undefined when the span is pure
   * kana (or has no annotations inside it). The renderer splits the surface
   * on these and shows ruby on the annotated sub-spans only.
   */
  rubies?: FuriganaAnnotation[];
}

export type SegmentPart = AnnotatedPart | CharPart | WordPart;

export interface DisplaySentence {
  /** Character offset where this sentence begins in the input text. */
  start: number;
  parts: SegmentPart[];
}

export interface DisplayParagraph {
  sentences: DisplaySentence[];
}

export function buildDisplaySegments(
  text: string,
  annotations: FuriganaAnnotation[]
): DisplayParagraph[] {
  const paragraphs: DisplayParagraph[] = [];
  let currentPara: DisplaySentence[] = [];
  let currentParts: SegmentPart[] = [];
  let currentSentStart = -1;
  let armed = true;
  let i = 0;
  let annIdx = 0;

  const flushSentence = () => {
    if (currentParts.length === 0) return;
    currentPara.push({
      start: currentSentStart,
      parts: currentParts,
    });
    currentParts = [];
    currentSentStart = -1;
  };

  const flushParagraph = () => {
    flushSentence();
    if (currentPara.length > 0) paragraphs.push({ sentences: currentPara });
    currentPara = [];
  };

  const startSentenceIfArmed = (atOffset: number) => {
    if (!armed) return;
    flushSentence();
    currentSentStart = atOffset;
    armed = false;
  };

  while (i < text.length) {
    while (annIdx < annotations.length && annotations[annIdx]!.end <= i) {
      annIdx++;
    }

    const ann = annIdx < annotations.length ? annotations[annIdx]! : null;
    if (ann && ann.start === i) {
      const ch0 = text[i]!;
      if (!SENTENCE_CLOSERS.has(ch0)) startSentenceIfArmed(i);
      currentParts.push({
        kind: "annotated",
        start: ann.start,
        end: ann.end,
        surface: text.slice(ann.start, ann.end),
        reading: ann.reading,
      });
      i = ann.end;
      annIdx++;
      continue;
    }

    const ch = text[i]!;

    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) {
        if (annIdx < annotations.length && annotations[annIdx]!.start === j) break;
        j++;
      }
      const newlines = (text.slice(i, j).match(/\n/g) || []).length;
      if (newlines >= 2) {
        flushParagraph();
        armed = true;
      } else if (newlines === 1) {
        flushSentence();
        armed = true;
      }
      i = j;
      continue;
    }

    if (!SENTENCE_CLOSERS.has(ch)) startSentenceIfArmed(i);
    currentParts.push({ kind: "char", offset: i, char: ch });
    if (SENTENCE_TERMINATORS.has(ch)) armed = true;
    i++;
  }

  flushParagraph();
  return paragraphs;
}
