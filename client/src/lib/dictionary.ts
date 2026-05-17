import {
  JpdictIdb,
  getWords,
  getKanji,
  type WordResult,
  type KanjiResult,
} from "@birchill/jpdict-idb";

export type DictionaryState = "idle" | "loading" | "ready" | "error";

let state: DictionaryState = "idle";
let initPromise: Promise<void> | null = null;
let lastError: string | null = null;
const listeners = new Set<(s: DictionaryState) => void>();

function setState(next: DictionaryState): void {
  state = next;
  for (const l of listeners) l(next);
}

export function getDictionaryState(): DictionaryState {
  return state;
}

export function getDictionaryError(): string | null {
  return lastError;
}

export function subscribeDictionary(listener: (s: DictionaryState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initDictionary(): Promise<void> {
  if (initPromise) return initPromise;

  setState("loading");
  lastError = null;

  initPromise = (async () => {
    const database = new JpdictIdb();

    await database.ready;

    // Words first (largest; most tap lookups hit this). Kanji piggy-backs.
    // Sequential avoids hammering the CDN with two concurrent multi-part
    // downloads for what's usually a one-time init.
    await database.update({ series: "words", lang: "en" });
    await database.update({ series: "kanji", lang: "en" });

    setState("ready");
  })().catch((err) => {
    lastError = err instanceof Error ? err.message : "Dictionary init failed";
    setState("error");
    initPromise = null;
    throw err;
  });

  return initPromise;
}

/**
 * Stable-partition `results` so WordResults that contain `search` as a
 * literal kanji or reading form sort ahead of ones that only matched after
 * the JMdict IDB folded hiragana and katakana together. The IDB's lookup
 * index treats でも and デモ as the same key, so a lookup of the hiragana
 * conjunction でも otherwise surfaces the katakana loanword デモ first — and
 * the word indexer, which stamps `results[0]`'s headword, then records every
 * でも occurrence under デモ. Order within each group is preserved, so a
 * lookup with no script ambiguity is returned untouched.
 */
export function preferExactScriptMatch(
  results: WordResult[],
  search: string
): WordResult[] {
  const isLiteral = (wr: WordResult): boolean =>
    (wr.k?.some((k) => k.ent === search) ?? false) ||
    (wr.r?.some((r) => r.ent === search) ?? false);
  const literal: WordResult[] = [];
  const folded: WordResult[] = [];
  for (const wr of results) (isLiteral(wr) ? literal : folded).push(wr);
  return [...literal, ...folded];
}

export async function lookupWord(search: string): Promise<WordResult[]> {
  if (state !== "ready" || !search) return [];
  const results = await getWords(search, { matchType: "exact", limit: 10 });
  return preferExactScriptMatch(results, search);
}

export async function lookupKanji(char: string): Promise<KanjiResult | null> {
  if (state !== "ready" || !char) return null;
  const results = await getKanji({ kanji: [char], lang: "en" });
  return results[0] ?? null;
}

export type { WordResult, KanjiResult };
