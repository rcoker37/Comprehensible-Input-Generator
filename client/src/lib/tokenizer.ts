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

  // App build serves the dict from /dict/ (copied into public/ by the root
  // postinstall). Headless tests (Node) point this at the real .dat files via
  // VITE_KUROMOJI_DICT_PATH. Read lazily so a test can set it before first use.
  const dicPath =
    (import.meta.env as Record<string, string | undefined>)
      .VITE_KUROMOJI_DICT_PATH ?? "/dict/";
  loading = new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, t) => {
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
  /**
   * Kuromoji's dictionary lemma (基本形) for the token — e.g. 'だ' for the
   * copula fragment 'だっ' in 'だった'. Used to tell a copula auxiliary apart
   * from a verb-conjugation auxiliary, both of which kuromoji tags 助動詞.
   */
  basicForm: string;
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
      basicForm: tok.basic_form,
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

/**
 * True when `token` is a copula auxiliary (だ / です / である) rather than a
 * verb-conjugation auxiliary (た / ます / ない …) — kuromoji tags both 助動詞,
 * so the lemma is what separates them.
 */
export function isCopulaToken(token: KuromojiTokenInfo | undefined): boolean {
  if (!token || token.pos !== "助動詞") return false;
  return token.basicForm === "だ" || token.basicForm === "です";
}

/**
 * The POS hint `lookupAtBoundary` should see for the token at index `i`.
 *
 * Almost always just the token's own POS, but it corrects one kuromoji
 * ambiguity: a 連用形 noun (終わり, 始め, 動き) is surface-identical to the
 * continuative of its verb (終わる, 始める, 動く), and kuromoji tags it 動詞.
 * That 動詞 hint makes `lookupAtBoundary` deinflect to the verb. When the very
 * next token is the copula (終わり + だった / です), the token is functioning
 * as a noun — a verb 連用形 is never directly followed by the copula — so the
 * hint is dropped (undefined) and the noun exact-match stands. Continuative
 * verbs before a comma or another verb keep their 動詞 hint untouched.
 */
export function verbHintAt(
  tokens: KuromojiTokenInfo[],
  i: number
): string | undefined {
  const token = tokens[i];
  if (!token) return undefined;
  if (token.pos === "動詞" && isCopulaToken(tokens[i + 1])) return undefined;
  return token.pos;
}

/** POS hint for the kuromoji token starting at `offset`, or undefined if none. */
export async function posHintAtOffset(
  text: string,
  offset: number
): Promise<string | undefined> {
  const tokens = await tokenizeTextCached(text);
  const i = tokens.findIndex((t) => t.start === offset);
  if (i === -1) return undefined;
  return verbHintAt(tokens, i);
}
