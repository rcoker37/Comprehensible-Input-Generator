import type { ValidationResult } from "../types/index.js";

const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

export function extractKanji(text: string): string[] {
  return [...new Set(text.match(KANJI_REGEX) || [])];
}

export function validate(
  story: string,
  allowedKanji: Set<string>
): ValidationResult {
  const usedKanji = extractKanji(story);
  const violations = usedKanji.filter((k) => !allowedKanji.has(k));
  return { valid: violations.length === 0, violations };
}
