import { describe, it, expect } from "vitest";
import { buildPrompt, FORMALITY_INSTRUCTIONS, rareKanjiNudge } from "./generation";

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
    expect(result).toContain("the chosen topic or writing style naturally calls for");
  });

  it("nudges the model to reach for topic- and style-specific vocabulary", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).toContain("lean into the concrete vocabulary and kanji that anchor a piece");
    expect(result).toContain("invitation, not just permission");
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

  it("omits the rare-kanji nudge when the pool is empty", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, []);
    expect(result).not.toContain("rarely encountered");
  });

  it("includes the rare-kanji nudge with the supplied pool", () => {
    const result = buildPrompt(
      "fiction",
      3,
      "日",
      "polite",
      undefined,
      undefined,
      ["湖", "駅", "森"]
    );
    expect(result).toContain("rarely encountered these allowed kanji");
    expect(result).toContain("湖、駅、森");
  });

  it("frames the rare-kanji nudge as if-and-only-if natural, not coverage", () => {
    const result = buildPrompt("fiction", 3, "日", "polite", undefined, undefined, ["湖"]);
    expect(result).toContain("If — and only if");
    expect(result).toContain("not coverage of the list");
  });
});

describe("rareKanjiNudge", () => {
  it("returns an empty string for an empty pool", () => {
    expect(rareKanjiNudge([])).toBe("");
  });

  it("joins the pool with full-width commas", () => {
    expect(rareKanjiNudge(["湖", "駅"])).toContain("湖、駅");
  });
});
