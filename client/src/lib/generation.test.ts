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

  it("instructs the model to minimize usage of non-allowed kanji", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("minimizing usage of kanji not in the list");
  });

  it("omits the stretch-kanji rule when unseenKanjiTarget is 'none'", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none");
    expect(result).not.toContain("stretch kanji");
  });

  it("includes a stretch-kanji rule when unseenKanjiTarget is set", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "3-5");
    expect(result).toContain("Include 3–5 unique kanji that are NOT in the allowed list");
    expect(result).toContain("stretch kanji");
  });

  it("uses the matching range for each unseenKanjiTarget value", () => {
    const r12 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "1-2");
    expect(r12).toContain("Include 1–2 unique kanji");
    const r510 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "5-10");
    expect(r510).toContain("Include 5–10 unique kanji");
  });

  it("drops the 'minimize non-allowed' rule when stretch kanji are requested", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "1-2");
    expect(result).not.toContain("minimizing usage of kanji not in the list");
  });

  it("omits the unseen-words rule when unseenWordTarget is 'none'", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "none", ["猫", "犬"]);
    expect(result).not.toContain("of these common words");
  });

  it("omits the unseen-words rule when the word pool is empty", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "3-5", []);
    expect(result).not.toContain("of these common words");
  });

  it("includes the unseen-words rule with the requested range and word pool", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "3-5", ["猫", "犬", "本"]);
    expect(result).toContain("3–5 of these common words");
    expect(result).toContain("猫、犬、本");
  });

  it("uses the matching range for each unseenWordTarget value", () => {
    const r12 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "1-2", ["猫"]);
    expect(r12).toContain("1–2 of these common words");
    const r510 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "5-10", ["猫"]);
    expect(r510).toContain("5–10 of these common words");
  });

  it("frames the unseen-words pool as a nudge, not the only new vocabulary", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "none", "3-5", ["猫"]);
    expect(result).toContain("only a nudge");
    expect(result).toContain("not meant to be the only unfamiliar words");
  });

  it("can request stretch kanji and unseen words at the same time", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, "1-2", "3-5", ["猫"]);
    expect(result).toContain("Include 1–2 unique kanji");
    expect(result).toContain("3–5 of these common words");
  });
});
