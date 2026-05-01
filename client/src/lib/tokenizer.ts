import kuromoji from "@aiktb/kuromoji";
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

/**
 * Morphological token used for TTS + synchronized highlighting + as the visual
 * unit the reader renders from.
 *   s: surface form
 *   r: hiragana reading (only set when the surface contains kanji and a reading
 *      is known — forced into SSML via <sub alias> so Azure pronounces the
 *      intended reading rather than guessing)
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
