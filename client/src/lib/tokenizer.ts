import kuromoji from "@aiktb/kuromoji";
import { KANJI_REGEX } from "./constants";

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
 */
export async function tokenizeForAudio(text: string): Promise<AudioToken[]> {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const out: AudioToken[] = [];

  for (const token of tokens) {
    const surface = token.surface_form;
    const hasKanji = [...surface].some((ch) => KANJI_REGEX.test(ch));

    if (hasKanji && token.reading && token.reading !== "*") {
      out.push({ s: surface, r: katakanaToHiragana(token.reading) });
    } else {
      out.push({ s: surface });
    }
  }

  return out;
}

/**
 * Tokenize Japanese text and produce furigana segments,
 * only attaching readings to kanji the user doesn't know.
 */
export async function getFurigana(
  text: string,
  unknownKanji: Set<string>
): Promise<FuriganaSegment[]> {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const segments: FuriganaSegment[] = [];

  for (const token of tokens) {
    const surface = token.surface_form;
    const reading = token.reading;

    const hasUnknown = [...surface].some(
      (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
    );

    if (!reading || !hasUnknown) {
      segments.push({ text: surface });
      continue;
    }

    // Token contains unknown kanji — attach reading to the whole token
    // (e.g., 先生 → せんせい, not per-character, since splitting compound
    // readings is unreliable)
    segments.push({ text: surface, reading: katakanaToHiragana(reading) });
  }

  return segments;
}
