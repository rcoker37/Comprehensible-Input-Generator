import { KANJI_REGEX } from "./constants";

/** Strip markdown bold markers (`**`) that LLMs sometimes add. */
export function stripBold(s: string): string {
  return s.replace(/\*\*/g, "");
}

/**
 * Remove markdown artifacts LLMs occasionally emit despite being told to output
 * plain Japanese. Safe to apply to whole-story text before saving.
 *
 * Handles: leading ATX headings (`#` through `######`), leading unordered-list
 * markers (`-`, `*`, `+`), leading blockquote markers (`>`), and bold/italic
 * emphasis markers (`**`, `__`). Line-oriented strippers require the marker at
 * the start of a line so we don't eat literal `#` or `-` that appears
 * legitimately mid-sentence.
 */
export function cleanGeneratedText(s: string): string {
  return s
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*>\s+/, "")
    )
    .join("\n")
    .replace(/\*\*/g, "")
    .replace(/__/g, "");
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
