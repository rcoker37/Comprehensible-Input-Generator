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

// Unicode punctuation, plus the fullwidth tilde (U+FF5E) — which Unicode
// categorises as a math symbol rather than punctuation.
const PUNCTUATION_REGEX = /[\p{P}～]/u;

/**
 * True when `ch` is a punctuation character — the brackets, commas, stops,
 * middle dots and marks that sit between words but are never themselves
 * dictionary entries. StoryDisplay uses this to render such characters as
 * inert text rather than tappable word tokens (no popover, no underline).
 *
 * Detection is Unicode `\p{P}`, which covers 、。！？「」『』（）・… and the
 * ASCII equivalents. It deliberately does NOT match ー (chōonpu), 々
 * (iteration mark) or 〇 — those are letter/number categories and form part
 * of real words (コーヒー, 人々), so they stay tappable.
 */
export function isPunctuation(ch: string): boolean {
  return PUNCTUATION_REGEX.test(ch);
}
