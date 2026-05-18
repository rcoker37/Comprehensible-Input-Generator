import { describe, it, expect } from "vitest";
import { buildPrompt, FORMALITY_INSTRUCTIONS } from "./generation";

describe("buildPrompt", () => {
  const defaults = {
    kanjiList: "日本語",
    formality: "polite" as const,
    paragraphs: 3,
  };

  it("includes the allowed kanji list", () => {
    const result = buildPrompt("fiction", defaults.paragraphs, defaults.kanjiList, defaults.formality);
    expect(result).toContain("Allowed kanji: 日本語");
  });

  it("includes story preamble for story type", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("writing a short story");
  });

  it("includes essay preamble for essay type", () => {
    const result = buildPrompt("nonfiction", 3, "日", "polite");
    expect(result).toContain("non-fiction, factual, educational essay");
  });

  it("includes the correct formality instruction", () => {
    for (const [formality, instruction] of Object.entries(FORMALITY_INSTRUCTIONS)) {
      const result = buildPrompt("fiction", 3, "日", formality as "polite");
      expect(result).toContain(instruction);
    }
  });

  it("includes topic when provided", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", "cooking");
    expect(result).toContain("The story should be about: cooking");
  });

  it("omits topic line when topic is undefined", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).not.toContain("should be about");
  });

  it("includes paragraph count for story type", () => {
    const result = buildPrompt("fiction", 5, "日", "polite");
    expect(result).toContain("Write exactly 5 paragraphs");
  });

  it("includes output-only instruction", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("Output ONLY the final content in Japanese");
  });

  it("scopes kanji to the allowed list and topic/style groups", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("Keep the kanji you use within these groups");
    expect(result).toContain("(1) kanji from the allowed list above");
    expect(result).toContain("vocabulary that naturally belongs in this piece");
  });

  it("describes the unseen-word kanji group only when unseen words are supplied", () => {
    const without = buildPrompt("fiction", 3, "日", "polite");
    expect(without).not.toContain("unseen common words listed below");
    const withWords = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "3-5", ["猫"]);
    expect(withWords).toContain("kanji that appear in the unseen common words listed below");
  });

  it("tells the model to write words in their standard spelling without substituting kana for kanji", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("standard modern spelling");
    expect(result).toContain("never 法《ほう》りつ");
    expect(result).toContain("rare or archaic");
  });

  it("clarifies that ordinary okurigana is not a kana substitution", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("Ordinary okurigana");
    expect(result).toContain("食べる");
  });

  it("tells the model a chosen word's kanji are all allowed", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("all of its kanji are allowed");
  });

  it("omits the unseen-words rule when unseenWordTarget is 'none'", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", ["猫", "犬"]);
    expect(result).not.toContain("of these common words");
  });

  it("omits the unseen-words rule when the word pool is empty", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "3-5", []);
    expect(result).not.toContain("of these common words");
  });

  it("includes the unseen-words rule with the requested range and word pool", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "3-5", ["猫", "犬", "本"]);
    expect(result).toContain("3–5 of these common words");
    expect(result).toContain("猫、犬、本");
  });

  it("uses the matching range for each unseenWordTarget value", () => {
    const r12 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "1-2", ["猫"]);
    expect(r12).toContain("1–2 of these common words");
    const r510 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "5-10", ["猫"]);
    expect(r510).toContain("5–10 of these common words");
  });

  it("frames the unseen-words pool as a nudge, not the only new vocabulary", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "3-5", ["猫"]);
    expect(result).toContain("only a nudge");
    expect(result).toContain("not meant to be the only unfamiliar words");
  });
});
