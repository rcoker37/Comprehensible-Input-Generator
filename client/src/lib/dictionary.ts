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

export async function lookupWord(search: string): Promise<WordResult[]> {
  if (state !== "ready" || !search) return [];
  return getWords(search, { matchType: "exact", limit: 10 });
}

export async function lookupKanji(char: string): Promise<KanjiResult | null> {
  if (state !== "ready" || !char) return null;
  const results = await getKanji({ kanji: [char], lang: "en" });
  return results[0] ?? null;
}

export type { WordResult, KanjiResult };
