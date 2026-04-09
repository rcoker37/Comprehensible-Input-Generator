import { KANJI_REGEX } from "./constants";

/** Strip markdown bold markers (`**`) that LLMs sometimes add. */
export function stripBold(s: string): string {
  return s.replace(/\*\*/g, "");
}

/** Return the set of kanji characters in `text` that are NOT in `knownKanji`. */
export function getUnknownKanji(text: string, knownKanji: Set<string>): Set<string> {
  const unknown = new Set<string>();
  for (const ch of text) {
    if (KANJI_REGEX.test(ch) && !knownKanji.has(ch)) {
      unknown.add(ch);
    }
  }
  return unknown;
}
