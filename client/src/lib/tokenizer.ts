import kuromoji from "@aiktb/kuromoji";
import { KANJI_REGEX } from "./constants";
import {
  tokenReadingFromAnnotations,
  type FuriganaAnnotation,
} from "./furigana";

let tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures> | null = null;
let loading: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | null = null;

function getTokenizer(): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: "/dict/" }).build((err, t) => {
      if (err) {
        loading = null;
        reject(err);
      } else {
        tokenizer = t;
        resolve(t);
      }
    });
  });

  return loading;
}

/** Preload the tokenizer dictionary in the background */
export function preloadTokenizer(): void {
  getTokenizer().catch((err) => {
    console.warn("Failed to preload tokenizer:", err);
  });
}

function katakanaToHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

export interface FuriganaSegment {
  text: string;
  reading?: string;
}

/**
 * Morphological token used for TTS + synchronized highlighting.
 *   s: surface form
 *   r: hiragana reading (only set when the surface contains kanji and kuromoji
 *      produced a reading — forced into SSML via <sub alias> so Azure pronounces
 *      the intended reading rather than guessing)
 *   t: start offset in milliseconds (populated by the server after synthesis)
 */
export interface AudioToken {
  s: string;
  r?: string;
  t?: number;
}

/**
 * Produce morphological tokens for a story, annotated with readings for
 * kanji-containing tokens. Concatenating `s` across tokens reproduces the
 * input text exactly — the token array is the canonical segmentation we
 * render from when audio exists, guaranteeing timing/highlight alignment.
 *
 * When `annotations` (LLM-provided ruby readings, parsed from Aozora
 * notation) are supplied, they take precedence over kuromoji's dictionary
 * readings. This lets us override IPADIC mistakes like 二人 → ににん with
 * the correct ふたり.
 *
 * Kuromoji may split a kanji compound into per-character tokens (e.g.
 * 二人 → [二, 人]). When an annotation spans across such a split, we merge
 * the affected tokens into one so the annotation's reading applies to the
 * whole kanji run.
 */
export async function tokenizeForAudio(
  text: string,
  annotations: FuriganaAnnotation[] = []
): Promise<AudioToken[]> {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const out: AudioToken[] = [];

  let charPos = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const tokenStart = charPos;
    const tokenEnd = tokenStart + token.surface_form.length;

    // If an annotation starts within this token but extends past its end,
    // merge forward until we cover the annotation's range. Using `find`
    // (rather than filter) is fine — we only care about the first such
    // annotation; additional overlapping annotations are resolved below in
    // tokenReadingFromAnnotations against the merged range.
    const straddling = annotations.find(
      (a) => a.start >= tokenStart && a.start < tokenEnd && a.end > tokenEnd
    );

    if (straddling) {
      let mergedSurface = token.surface_form;
      let mergedEnd = tokenEnd;
      let j = i + 1;
      while (mergedEnd < straddling.end && j < tokens.length) {
        mergedSurface += tokens[j].surface_form;
        mergedEnd += tokens[j].surface_form.length;
        j++;
      }
      const reading = tokenReadingFromAnnotations(
        mergedSurface,
        tokenStart,
        annotations,
        undefined
      );
      out.push(reading ? { s: mergedSurface, r: reading } : { s: mergedSurface });
      charPos = mergedEnd;
      i = j;
      continue;
    }

    const kuromojiReading =
      token.reading && token.reading !== "*"
        ? katakanaToHiragana(token.reading)
        : undefined;
    const reading = tokenReadingFromAnnotations(
      token.surface_form,
      tokenStart,
      annotations,
      kuromojiReading
    );
    out.push(reading ? { s: token.surface_form, r: reading } : { s: token.surface_form });
    charPos = tokenEnd;
    i++;
  }

  return out;
}

/**
 * Annotation-shaped token matching the IncomingToken contract of the
 * annotate-story edge function. Same surface/reading as AudioToken, plus a
 * coarse POS tag and an isContent flag used by the reader to decide which
 * spans are tappable. `b` holds the kuromoji base form when it differs from
 * the surface (for inflected verbs/adjectives) so dictionary lookup can fall
 * back to the lemma and actually find JMdict entries.
 */
export interface AnnotationInputToken {
  s: string;
  r?: string;
  b?: string;
  pos?: string;
  isContent: boolean;
}

function classifyPos(pos: string, posDetail1: string): { tag: string; isContent: boolean } {
  switch (pos) {
    case "名詞":
      // 名詞 covers proper nouns, numbers, and non-content sub-types like 非自立 / 接尾.
      if (posDetail1 === "数") return { tag: "num", isContent: true };
      if (posDetail1 === "非自立" || posDetail1 === "接尾") {
        return { tag: "noun", isContent: false };
      }
      return { tag: "noun", isContent: true };
    case "動詞":
      // Auxiliary-like verbs (する, ある used grammatically) are still content for lookup.
      return { tag: "verb", isContent: true };
    case "形容詞":
      return { tag: "adj", isContent: true };
    case "副詞":
      return { tag: "adv", isContent: true };
    case "連体詞":
      return { tag: "adn", isContent: true };
    case "感動詞":
      return { tag: "interj", isContent: true };
    case "接続詞":
      return { tag: "conj", isContent: true };
    case "助詞":
      return { tag: "particle", isContent: false };
    case "助動詞":
      return { tag: "aux", isContent: false };
    case "記号":
      return { tag: "punct", isContent: false };
    case "フィラー":
      return { tag: "filler", isContent: false };
    default:
      return { tag: "other", isContent: false };
  }
}

/**
 * Tokenize a story for the annotate-story edge function. Mirrors
 * tokenizeForAudio's merging of kuromoji splits when an annotation straddles
 * them, and tags each token with a simplified POS + isContent flag.
 */
export async function tokenizeForAnnotations(
  text: string,
  annotations: FuriganaAnnotation[] = []
): Promise<AnnotationInputToken[]> {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const out: AnnotationInputToken[] = [];

  let charPos = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const tokenStart = charPos;
    const tokenEnd = tokenStart + token.surface_form.length;

    const straddling = annotations.find(
      (a) => a.start >= tokenStart && a.start < tokenEnd && a.end > tokenEnd
    );

    if (straddling) {
      let mergedSurface = token.surface_form;
      let mergedEnd = tokenEnd;
      let j = i + 1;
      while (mergedEnd < straddling.end && j < tokens.length) {
        mergedSurface += tokens[j].surface_form;
        mergedEnd += tokens[j].surface_form.length;
        j++;
      }
      const reading = tokenReadingFromAnnotations(
        mergedSurface,
        tokenStart,
        annotations,
        undefined
      );
      const classified = classifyPos(token.pos, token.pos_detail_1);
      const base =
        token.basic_form && token.basic_form !== "*" && token.basic_form !== mergedSurface
          ? token.basic_form
          : undefined;
      out.push({
        s: mergedSurface,
        ...(reading ? { r: reading } : {}),
        ...(base ? { b: base } : {}),
        pos: classified.tag,
        isContent: classified.isContent,
      });
      charPos = mergedEnd;
      i = j;
      continue;
    }

    const kuromojiReading =
      token.reading && token.reading !== "*"
        ? katakanaToHiragana(token.reading)
        : undefined;
    const reading = tokenReadingFromAnnotations(
      token.surface_form,
      tokenStart,
      annotations,
      kuromojiReading
    );
    const classified = classifyPos(token.pos, token.pos_detail_1);
    const base =
      token.basic_form && token.basic_form !== "*" && token.basic_form !== token.surface_form
        ? token.basic_form
        : undefined;
    out.push({
      s: token.surface_form,
      ...(reading ? { r: reading } : {}),
      ...(base ? { b: base } : {}),
      pos: classified.tag,
      isContent: classified.isContent,
    });
    charPos = tokenEnd;
    i++;
  }

  return out;
}

/**
 * Tokenize Japanese text and produce furigana segments, only attaching
 * readings to kanji the user doesn't know. When `annotations` are supplied
 * (LLM-provided ruby), they override kuromoji's dictionary readings. Merges
 * kuromoji tokens the same way tokenizeForAudio does when an annotation
 * spans across a kuromoji split.
 */
export async function getFurigana(
  text: string,
  unknownKanji: Set<string>,
  annotations: FuriganaAnnotation[] = []
): Promise<FuriganaSegment[]> {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const segments: FuriganaSegment[] = [];

  let charPos = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const tokenStart = charPos;
    const tokenEnd = tokenStart + token.surface_form.length;

    const straddling = annotations.find(
      (a) => a.start >= tokenStart && a.start < tokenEnd && a.end > tokenEnd
    );

    let surface: string;
    let start: number;
    let kuromojiReading: string | undefined;
    if (straddling) {
      let mergedSurface = token.surface_form;
      let mergedEnd = tokenEnd;
      let j = i + 1;
      while (mergedEnd < straddling.end && j < tokens.length) {
        mergedSurface += tokens[j].surface_form;
        mergedEnd += tokens[j].surface_form.length;
        j++;
      }
      surface = mergedSurface;
      start = tokenStart;
      kuromojiReading = undefined;
      charPos = mergedEnd;
      i = j;
    } else {
      surface = token.surface_form;
      start = tokenStart;
      kuromojiReading =
        token.reading && token.reading !== "*"
          ? katakanaToHiragana(token.reading)
          : undefined;
      charPos = tokenEnd;
      i++;
    }

    const hasUnknown = [...surface].some(
      (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
    );
    if (!hasUnknown) {
      segments.push({ text: surface });
      continue;
    }

    const reading = tokenReadingFromAnnotations(
      surface,
      start,
      annotations,
      kuromojiReading
    );
    segments.push(reading ? { text: surface, reading } : { text: surface });
  }

  return segments;
}
