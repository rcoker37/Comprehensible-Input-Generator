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

  it("omits the underused-kanji directive when not provided", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).not.toContain("seen rarely");
  });

  it("omits the underused-kanji directive when the list is empty", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, []);
    expect(result).not.toContain("seen rarely");
  });

  it("includes the underused-kanji directive when characters are provided", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, ["漁", "傘", "磁"]);
    expect(result).toContain("seen rarely: 漁傘磁");
    expect(result).toContain("at least 3–5 of them");
  });

  it("instructs the model to minimize usage of non-allowed kanji", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("minimizing usage of kanji not in the list");
  });

  it("omits the stretch-kanji rule when unseenKanjiTarget is 'none'", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, undefined, "none");
    expect(result).not.toContain("stretch kanji");
  });

  it("includes a stretch-kanji rule when unseenKanjiTarget is set", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, undefined, "3-5");
    expect(result).toContain("Include 3–5 unique kanji that are NOT in the allowed list");
    expect(result).toContain("stretch kanji");
  });

  it("uses the matching range for each unseenKanjiTarget value", () => {
    const r12 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, undefined, "1-2");
    expect(r12).toContain("Include 1–2 unique kanji");
    const r510 = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, undefined, "5-10");
    expect(r510).toContain("Include 5–10 unique kanji");
  });

  it("drops the 'minimize non-allowed' rule when stretch kanji are requested", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, undefined, "1-2");
    expect(result).not.toContain("minimizing usage of kanji not in the list");
  });
});
