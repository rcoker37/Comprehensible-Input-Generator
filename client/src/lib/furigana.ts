// Aozora Bunko ruby-notation parser.
//
// LLMs are asked (see prompt in ./generation.ts) to produce text where every
// kanji run is immediately followed by a full-width 《…》 block containing its
// hiragana reading, e.g.:
//
//   二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。
//
// The reading covers ONLY the kanji run, NOT trailing okurigana — this is the
// strict Aozora convention. It's also far cheaper to align with kuromoji
// tokens than a "whole word" reading style.
//
// We trust LLM readings as ground truth and fall back to kuromoji's dictionary
// only when an annotation is missing (e.g., older stories, LLM oversights).

import { KANJI_REGEX } from "./constants";

export interface FuriganaAnnotation {
  /** Inclusive start offset in the *clean* text (annotations stripped). */
  start: number;
  /** Exclusive end offset in the clean text. */
  end: number;
  /** Hiragana reading for the kanji run at [start, end). */
  reading: string;
}

export interface ParsedFurigana {
  cleanText: string;
  annotations: FuriganaAnnotation[];
}

// Kanji run followed by 《reading》. The reading may contain hiragana,
// katakana, or the long-vowel mark — never another 《 or 》.
//
// The base allows CJK Unified Ideographs plus 々 (U+3005, the kanji
// iteration mark): 人々, 時々, 日々 read as a single word and are annotated
// as one ruby block. 々 is not itself a kanji in Unicode (CJK Symbols &
// Punctuation block) so it must be whitelisted explicitly.
const RUBY_RE = /([\u4e00-\u9faf\u3400-\u4dbf\u3005]+)《([^《》]+)》/g;

/**
 * Strip Aozora ruby annotations from `raw` and return both the clean text and
 * the annotation positions relative to that clean text.
 *
 * If `raw` contains no ruby annotations, this is effectively a pass-through
 * (returns the text unchanged with an empty annotations array).
 */
export function parseAnnotatedText(raw: string): ParsedFurigana {
  RUBY_RE.lastIndex = 0;
  const annotations: FuriganaAnnotation[] = [];
  let clean = "";
  let cursor = 0;

  let match: RegExpExecArray | null;
  while ((match = RUBY_RE.exec(raw)) !== null) {
    const matchStart = match.index;
    const base = match[1];
    const reading = match[2];

    // Append text between the last match and this one.
    clean += raw.slice(cursor, matchStart);
    const annStart = clean.length;
    clean += base;
    const annEnd = clean.length;
    annotations.push({ start: annStart, end: annEnd, reading });
    cursor = matchStart + match[0].length;
  }
  // Tail after the final match.
  clean += raw.slice(cursor);

  return { cleanText: clean, annotations };
}

/** Strip annotations without tracking positions. Cheap; safe on partial streams. */
export function stripAnnotations(raw: string): string {
  return raw.replace(/《[^《》]*》/g, "");
}

/**
 * Compose the reading for a kuromoji token that spans [tokenStart, tokenEnd)
 * in the clean text, using LLM annotations where available and falling back
 * to the kuromoji-provided reading for any portion without an annotation.
 *
 * Returns `undefined` only when the token has no kanji AND no annotation —
 * in that case the caller should treat the surface itself as the reading
 * (hiragana/katakana is pronounced unambiguously).
 */
export function tokenReadingFromAnnotations(
  tokenSurface: string,
  tokenStart: number,
  annotations: FuriganaAnnotation[],
  kuromojiReadingHiragana?: string
): string | undefined {
  const tokenEnd = tokenStart + tokenSurface.length;
  const covering = annotations.filter(
    (a) => a.start >= tokenStart && a.end <= tokenEnd
  );

  // Fast paths.
  if (covering.length === 0) {
    const hasKanji = [...tokenSurface].some((ch) => KANJI_REGEX.test(ch));
    return hasKanji ? kuromojiReadingHiragana : undefined;
  }

  // Walk the token range, replacing each covered kanji run with its reading
  // and keeping non-kanji characters (okurigana, punctuation) verbatim.
  covering.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = tokenStart;
  for (const ann of covering) {
    if (ann.start > pos) {
      out += tokenSurface.slice(pos - tokenStart, ann.start - tokenStart);
    }
    out += ann.reading;
    pos = ann.end;
  }
  if (pos < tokenEnd) {
    out += tokenSurface.slice(pos - tokenStart, tokenEnd - tokenStart);
  }
  return out;
}
