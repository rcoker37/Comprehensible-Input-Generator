import { describe, it, expect } from "vitest";
import {
  parseAnnotatedText,
  stripAnnotations,
  tokenReadingFromAnnotations,
} from "./furigana";

describe("parseAnnotatedText", () => {
  it("passes through text with no annotations", () => {
    const { cleanText, annotations } = parseAnnotatedText("こんにちは世界");
    expect(cleanText).toBe("こんにちは世界");
    expect(annotations).toEqual([]);
  });

  it("extracts a single annotation", () => {
    const { cleanText, annotations } = parseAnnotatedText("二人《ふたり》");
    expect(cleanText).toBe("二人");
    expect(annotations).toEqual([{ start: 0, end: 2, reading: "ふたり" }]);
  });

  it("extracts multiple annotations with intervening plain text", () => {
    const { cleanText, annotations } = parseAnnotatedText(
      "二人《ふたり》は公園《こうえん》で遊んだ。"
    );
    expect(cleanText).toBe("二人は公園で遊んだ。");
    expect(annotations).toEqual([
      { start: 0, end: 2, reading: "ふたり" },
      { start: 3, end: 5, reading: "こうえん" },
    ]);
  });

  it("annotates only the kanji run, leaving okurigana in the clean text", () => {
    const { cleanText, annotations } = parseAnnotatedText(
      "行《おこな》われた大会《たいかい》"
    );
    expect(cleanText).toBe("行われた大会");
    expect(annotations).toEqual([
      { start: 0, end: 1, reading: "おこな" },
      { start: 4, end: 6, reading: "たいかい" },
    ]);
  });

  it("is safe against empty readings (ignored)", () => {
    // A 《》 with an empty inside won't match the regex (requires 1+ char).
    const { cleanText, annotations } = parseAnnotatedText("漢字《》");
    expect(cleanText).toBe("漢字《》");
    expect(annotations).toEqual([]);
  });

  it("does not cross paragraph boundaries", () => {
    const { cleanText, annotations } = parseAnnotatedText(
      "今日《きょう》\n\n明日《あした》"
    );
    expect(cleanText).toBe("今日\n\n明日");
    expect(annotations).toHaveLength(2);
  });
});

describe("stripAnnotations", () => {
  it("removes 《…》 blocks", () => {
    expect(stripAnnotations("二人《ふたり》は公園《こうえん》へ")).toBe(
      "二人は公園へ"
    );
  });

  it("is a no-op on plain text", () => {
    expect(stripAnnotations("こんにちは")).toBe("こんにちは");
  });

  it("handles partial streams gracefully (unterminated 《 stays put)", () => {
    expect(stripAnnotations("二人《ふたり")).toBe("二人《ふたり");
  });
});

describe("tokenReadingFromAnnotations", () => {
  it("returns undefined for a pure-kana token with no annotation", () => {
    expect(tokenReadingFromAnnotations("です", 10, [], undefined)).toBeUndefined();
  });

  it("falls back to kuromoji reading when no annotation covers the token", () => {
    expect(
      tokenReadingFromAnnotations("先生", 0, [], "せんせい")
    ).toBe("せんせい");
  });

  it("uses annotation reading when the token is a pure kanji run", () => {
    const anns = [{ start: 0, end: 2, reading: "ふたり" }];
    expect(tokenReadingFromAnnotations("二人", 0, anns, "ににん")).toBe("ふたり");
  });

  it("combines annotation reading with trailing okurigana", () => {
    // Clean text: "行われた" (positions 0..4). Annotation covers kanji 行 at [0, 1).
    // Kuromoji emits a single token spanning the whole thing.
    const anns = [{ start: 0, end: 1, reading: "おこな" }];
    expect(
      tokenReadingFromAnnotations("行われた", 0, anns, "いかれた")
    ).toBe("おこなわれた");
  });

  it("handles a token offset into the clean text", () => {
    // Clean text: "私は二人" — token 二人 starts at index 2.
    const anns = [{ start: 2, end: 4, reading: "ふたり" }];
    expect(tokenReadingFromAnnotations("二人", 2, anns, undefined)).toBe("ふたり");
  });

  it("ignores annotations that don't overlap this token", () => {
    const anns = [
      { start: 0, end: 2, reading: "ふたり" },
      { start: 10, end: 12, reading: "こうえん" },
    ];
    expect(tokenReadingFromAnnotations("公園", 10, anns, undefined)).toBe("こうえん");
  });
});
