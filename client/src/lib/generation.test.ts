import { describe, it, expect } from "vitest";
import {
  buildLearnWordPrompt,
  buildPrompt,
  FORMALITY_INSTRUCTIONS,
} from "./generation";
import { newWordTarget } from "./comprehensibility";

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

  it("omits the reader-level block when no vocabLevel is given", () => {
    const result = buildPrompt("fiction", 3, "日", "polite");
    expect(result).not.toContain("Reader vocabulary level");
  });

  it("injects the reader level and an i+1 new-word floor for a vocabLevel", () => {
    const level = {
      label: "upper-beginner (around JLPT N4)",
      blurb: "an upper-beginner reader",
    };
    const result = buildPrompt("fiction", 5, "日", "polite", undefined, undefined, level);
    expect(result).toContain(
      "Reader vocabulary level: upper-beginner (around JLPT N4)"
    );
    // The floor scales with paragraph count (5 -> 10).
    expect(result).toContain(`at least ${newWordTarget(5)} words that are new`);
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
});

describe("buildLearnWordPrompt", () => {
  it("names the target word and the allowed kanji list", () => {
    const result = buildLearnWordPrompt("約束", 3, "日本語", "polite");
    expect(result).toContain("The word to teach: 「約束」");
    expect(result).toContain("Allowed kanji: 日本語");
  });

  it("asks for meaning, usage, and example sentences", () => {
    const result = buildLearnWordPrompt("約束", 3, "日", "polite");
    expect(result).toContain("Explain what 「約束」 means");
    expect(result).toContain("example sentences");
  });

  it("restricts kanji to the allowed list plus the target word, with no topical group", () => {
    const result = buildLearnWordPrompt("約束", 3, "日", "polite");
    expect(result).toContain("(2) the kanji of 「約束」 itself");
    expect(result).toContain("This restriction is strict");
    expect(result).not.toContain("topic or writing style naturally calls for");
  });

  it("keeps the shared spelling and ruby rules", () => {
    const result = buildLearnWordPrompt("約束", 3, "日", "polite");
    expect(result).toContain("standard modern spelling");
    expect(result).toContain("Aozora Bunko ruby notation");
    expect(result).toContain("all of its kanji are allowed");
  });

  it("includes formality, paragraph count, and the output footer", () => {
    const result = buildLearnWordPrompt("約束", 4, "日", "keigo");
    expect(result).toContain(FORMALITY_INSTRUCTIONS.keigo);
    expect(result).toContain("Write exactly 4 paragraphs");
    expect(result).toContain("Output ONLY the final content in Japanese");
    expect(result).toContain("title on the first line should contain 「約束」");
  });

  it("sanitizes newlines and markdown control characters out of the word", () => {
    const result = buildLearnWordPrompt("約束\n#`", 3, "日", "polite");
    expect(result).toContain("The word to teach: 「約束」");
  });

  it("pins the homograph with a reading note when a reading is supplied", () => {
    const result = buildLearnWordPrompt("辛い", 3, "日", "polite", "からい");
    expect(result).toContain("The word to teach: 「辛い」（からい）");
  });

  it("omits the reading note for kana-only headwords and missing readings", () => {
    expect(buildLearnWordPrompt("あなた", 3, "日", "polite", "あなた")).toContain(
      "The word to teach: 「あなた」\n"
    );
    expect(buildLearnWordPrompt("約束", 3, "日", "polite", null)).toContain(
      "The word to teach: 「約束」\n"
    );
  });
});
