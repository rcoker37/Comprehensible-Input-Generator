// Thin wrapper around @aiktb/kuromoji used only by the tap-grouping pass.
// Kuromoji's IPADIC analyser knows enough about Japanese morphology to draw
// reasonable word boundaries (particles vs. inflections, common compounds),
// which we then use as a sieve for dictionary-based grouping in regroupWords:
// only matches that align with a kuromoji boundary are accepted, so JMdict's
// rare interjections (e.g. があ) can't shadow the obvious が|あります split.

import kuromoji from "@aiktb/kuromoji";

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

/** Kick off the dict download in the background so the first regroup pass
 *  doesn't pay the full ~12MB load latency. */
export function preloadTokenizer(): void {
  getTokenizer().catch((err) => {
    console.warn("Failed to preload tokenizer:", err);
  });
}

export interface KuromojiTokenInfo {
  surface: string;
  /** Inclusive char offset (UTF-16 code units, matches String.prototype.slice). */
  start: number;
  /** Exclusive char offset. */
  end: number;
  /**
   * Top-level kuromoji POS (品詞) — '名詞', '動詞', '助動詞', '助詞', etc.
   * Used by the regroup pass to keep verb stems attached to trailing
   * auxiliaries; see `regroupWords.ts`.
   */
  pos: string;
}

/**
 * Tokenise `text` and return offsets into the original string. Concatenating
 * `surface` across the result reproduces the input exactly.
 */
export async function tokenizeText(text: string): Promise<KuromojiTokenInfo[]> {
  if (text.length === 0) return [];
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const out: KuromojiTokenInfo[] = [];
  let cursor = 0;
  for (const tok of tokens) {
    const surface = tok.surface_form;
    out.push({
      surface,
      start: cursor,
      end: cursor + surface.length,
      pos: tok.pos,
    });
    cursor += surface.length;
  }
  return out;
}

// Small per-cleanText cache so the popover can repeatedly fetch the kuromoji
// POS at a tap offset without re-tokenising. The regroup pass already
// tokenised this story's text once; this cache makes the popover's reuse
// effectively free. Bounded to avoid retaining tokens for stories the user
// has long since closed.
const tokenCache = new Map<string, Promise<KuromojiTokenInfo[]>>();
const MAX_TOKEN_CACHE = 16;

export function tokenizeTextCached(text: string): Promise<KuromojiTokenInfo[]> {
  const cached = tokenCache.get(text);
  if (cached) return cached;
  if (tokenCache.size >= MAX_TOKEN_CACHE) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  const p = tokenizeText(text);
  tokenCache.set(text, p);
  return p;
}

/** POS of the kuromoji token starting at `offset`, or undefined if none. */
export async function posHintAtOffset(
  text: string,
  offset: number
): Promise<string | undefined> {
  const tokens = await tokenizeTextCached(text);
  return tokens.find((t) => t.start === offset)?.pos;
}
