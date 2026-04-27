import { describe, it, expect } from "vitest";
import { buildPrompt, computeDifficulty, FORMALITY_INSTRUCTIONS, GRAMMAR_GUIDANCE } from "./generation";

describe("buildPrompt", () => {
  const defaults = {
    kanjiList: "日本語",
    formality: "polite" as const,
    grammarLevel: 3,
    paragraphs: 3,
  };

  it("includes the allowed kanji list", () => {
    const result = buildPrompt("story", defaults.paragraphs, defaults.kanjiList, defaults.formality, defaults.grammarLevel);
    expect(result).toContain("Allowed kanji: 日本語");
  });

  it("includes story preamble for story type", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3);
    expect(result).toContain("writing a short story");
  });

  it("includes dialogue preamble for dialogue type", () => {
    const result = buildPrompt("dialogue", 3, "日", "polite", 3);
    expect(result).toContain("writing a dialogue");
  });

  it("includes essay preamble for essay type", () => {
    const result = buildPrompt("essay", 3, "日", "polite", 3);
    expect(result).toContain("non-fiction, factual, educational essay");
  });

  it("includes the correct formality instruction", () => {
    for (const [formality, instruction] of Object.entries(FORMALITY_INSTRUCTIONS)) {
      const result = buildPrompt("story", 3, "日", formality as "polite", 3);
      expect(result).toContain(instruction);
    }
  });

  it("includes the correct grammar guidance", () => {
    for (const [level, guidance] of Object.entries(GRAMMAR_GUIDANCE)) {
      const result = buildPrompt("story", 3, "日", "polite", Number(level));
      expect(result).toContain(guidance);
    }
  });

  it("falls back to N2 grammar for unknown level", () => {
    const result = buildPrompt("story", 3, "日", "polite", 99);
    expect(result).toContain(GRAMMAR_GUIDANCE[2]);
  });

  it("includes topic when provided", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3, "cooking");
    expect(result).toContain("The story should be about: cooking");
  });

  it("uses dialogue topic label for dialogue type", () => {
    const result = buildPrompt("dialogue", 3, "日", "polite", 3, "school");
    expect(result).toContain("The dialogue should be about: school");
  });

  it("omits topic line when topic is undefined", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3);
    expect(result).not.toContain("should be about");
  });

  it("includes paragraph count for story type", () => {
    const result = buildPrompt("story", 5, "日", "polite", 3);
    expect(result).toContain("Write exactly 5 paragraphs");
  });

  it("includes exchange count for dialogue type", () => {
    const result = buildPrompt("dialogue", 4, "日", "polite", 3);
    expect(result).toContain("Write exactly 4 exchanges");
  });

  it("includes output-only instruction", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3);
    expect(result).toContain("Output ONLY the final content in Japanese");
  });

  it("omits the underused-kanji directive when not provided", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3);
    expect(result).not.toContain("seen rarely");
  });

  it("omits the underused-kanji directive when the list is empty", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3, undefined, undefined, []);
    expect(result).not.toContain("seen rarely");
  });

  it("includes the underused-kanji directive when characters are provided", () => {
    const result = buildPrompt("story", 3, "日", "polite", 3, undefined, undefined, ["漁", "傘", "磁"]);
    expect(result).toContain("seen rarely: 漁傘磁");
  });
});

describe("computeDifficulty", () => {
  it("returns zeroes for text with no kanji", () => {
    const meta = new Map();
    const result = computeDifficulty("こんにちは", meta);
    expect(result).toEqual({
      uniqueKanji: 0,
      grade: { max: 0, avg: 0 },
      jlpt: { min: 0, avg: 0 },
    });
  });

  it("computes stats for known kanji", () => {
    const meta = new Map([
      ["日", { grade: 1, jlpt: 5 }],
      ["本", { grade: 1, jlpt: 4 }],
    ]);
    const result = computeDifficulty("日本", meta);
    expect(result.uniqueKanji).toBe(2);
    expect(result.grade.max).toBe(1);
    expect(result.grade.avg).toBe(1);
    expect(result.jlpt.min).toBe(4);
    expect(result.jlpt.avg).toBe(4.5);
  });

  it("counts duplicate kanji only once", () => {
    const meta = new Map([["日", { grade: 1, jlpt: 5 }]]);
    const result = computeDifficulty("日日日", meta);
    expect(result.uniqueKanji).toBe(1);
  });

  it("handles kanji not in the meta map", () => {
    const meta = new Map([["日", { grade: 1, jlpt: 5 }]]);
    const result = computeDifficulty("日本", meta);
    expect(result.uniqueKanji).toBe(2);
    // Only 日 is in meta, so grade stats are based on just that one
    expect(result.grade.max).toBe(1);
    expect(result.grade.avg).toBe(1);
  });

  it("handles kanji with null jlpt", () => {
    const meta = new Map([
      ["日", { grade: 1, jlpt: 5 }],
      ["嬉", { grade: 8, jlpt: null }],
    ]);
    const result = computeDifficulty("日嬉", meta);
    expect(result.uniqueKanji).toBe(2);
    expect(result.grade.max).toBe(8);
    // jlpt stats should only include non-null entries
    expect(result.jlpt.min).toBe(5);
    expect(result.jlpt.avg).toBe(5);
  });
});
