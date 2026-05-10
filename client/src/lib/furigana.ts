// Aozora Bunko ruby-notation parser.
//
// LLMs are asked (see prompt in ./generation.ts) to produce text where every
// kanji run is immediately followed by a full-width 《…》 block containing its
// hiragana reading, e.g.:
//
//   二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。
//
// The reading covers ONLY the kanji run, NOT trailing okurigana — this is the
// strict Aozora convention.
//
// LLM readings are the source of truth — when an annotation is missing,
// readers see the kanji without ruby.

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

// Kanji run (optionally followed by trailing hiragana okurigana) + 《reading》.
// The reading may contain hiragana, katakana, or the long-vowel mark — never
// another 《 or 》.
//
// The kanji class allows CJK Unified Ideographs plus 々 (U+3005, the kanji
// iteration mark): 人々, 時々, 日々 read as a single word and are annotated
// as one ruby block. 々 is not itself a kanji in Unicode (CJK Symbols &
// Punctuation block) so it must be whitelisted explicitly.
//
// The trailing-hiragana group handles word-level annotations the LLM
// sometimes emits despite being told to use strict kanji-only form (e.g.
// 多く《おおく》 instead of 多《おお》く). We absorb those hiragana into the
// ruby base only when the reading's tail matches them — otherwise the
// trailing hiragana are preserved verbatim in the clean text (see
// parseAnnotatedText below).
const RUBY_RE = /([\u4e00-\u9faf\u3400-\u4dbf\u3005]+)([\u3040-\u309f]*)《([^《》]+)》/g;

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
    const kanjiRun = match[1] ?? "";
    const okurigana = match[2] ?? "";
    const reading = match[3] ?? "";

    // Append text between the last match and this one.
    clean += raw.slice(cursor, matchStart);

    // Word-level annotation: if the LLM put hiragana between the kanji and
    // the reading block (e.g. 多く《おおく》), absorb those hiragana into the
    // ruby base — but only when the reading actually ends with them, so we
    // don't over-capture particles like 私は《わたし》.
    const absorb = okurigana.length > 0 && reading.endsWith(okurigana);
    const base = absorb ? kanjiRun + okurigana : kanjiRun;

    const annStart = clean.length;
    clean += base;
    const annEnd = clean.length;
    annotations.push({ start: annStart, end: annEnd, reading });

    if (!absorb && okurigana.length > 0) {
      clean += okurigana;
    }

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
 * Compose the reading for a surface that spans [start, start+length) in the
 * clean text, using LLM annotations where available. Returns `undefined`
 * when no annotation covers any part of the surface (the caller decides
 * whether to render plain text or fall back to a heuristic).
 */
export function surfaceReadingFromAnnotations(
  surface: string,
  start: number,
  annotations: FuriganaAnnotation[]
): string | undefined {
  const end = start + surface.length;
  const covering = annotations.filter(
    (a) => a.start >= start && a.end <= end
  );
  if (covering.length === 0) return undefined;

  // Walk the surface, replacing each covered kanji run with its reading and
  // keeping non-kanji characters (okurigana, punctuation) verbatim.
  covering.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = start;
  for (const ann of covering) {
    if (ann.start > pos) {
      out += surface.slice(pos - start, ann.start - start);
    }
    out += ann.reading;
    pos = ann.end;
  }
  if (pos < end) {
    out += surface.slice(pos - start, end - start);
  }
  return out;
}
