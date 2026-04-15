import { describe, it, expect } from "vitest";
import { stripBold, cleanGeneratedText, getUnknownKanji } from "./text";

describe("stripBold", () => {
  it("returns empty string unchanged", () => {
    expect(stripBold("")).toBe("");
  });

  it("returns text without bold markers unchanged", () => {
    expect(stripBold("hello world")).toBe("hello world");
  });

  it("strips paired bold markers", () => {
    expect(stripBold("**hello** world")).toBe("hello world");
  });

  it("strips multiple bold markers", () => {
    expect(stripBold("**a** and **b**")).toBe("a and b");
  });

  it("strips incomplete/unpaired markers", () => {
    expect(stripBold("**hello")).toBe("hello");
  });
});

describe("cleanGeneratedText", () => {
  it("is a no-op on clean text", () => {
    expect(cleanGeneratedText("今日は良い天気です。")).toBe("今日は良い天気です。");
  });

  it("strips ATX heading markers at line start", () => {
    expect(cleanGeneratedText("# 二人のレース\n\n今日は...")).toBe("二人のレース\n\n今日は...");
  });

  it("strips deeper headings", () => {
    expect(cleanGeneratedText("### 小見出し")).toBe("小見出し");
  });

  it("strips list markers at line start", () => {
    expect(cleanGeneratedText("- 一つ目\n* 二つ目\n+ 三つ目")).toBe(
      "一つ目\n二つ目\n三つ目"
    );
  });

  it("strips blockquote markers at line start", () => {
    expect(cleanGeneratedText("> 引用です")).toBe("引用です");
  });

  it("strips paired bold markers", () => {
    expect(cleanGeneratedText("**太字**の文章")).toBe("太字の文章");
  });

  it("strips underscore emphasis", () => {
    expect(cleanGeneratedText("__強調__")).toBe("強調");
  });

  it("does not strip # that appears mid-line", () => {
    expect(cleanGeneratedText("タグは #1 と呼ばれる。")).toBe("タグは #1 と呼ばれる。");
  });

  it("preserves Aozora ruby annotations untouched", () => {
    expect(cleanGeneratedText("# 二人《ふたり》")).toBe("二人《ふたり》");
  });
});

describe("getUnknownKanji", () => {
  it("returns empty set for empty text", () => {
    const result = getUnknownKanji("", new Set());
    expect(result.size).toBe(0);
  });

  it("returns empty set for hiragana-only text", () => {
    const result = getUnknownKanji("こんにちは", new Set());
    expect(result.size).toBe(0);
  });

  it("returns empty set when all kanji are known", () => {
    const known = new Set(["日", "本"]);
    const result = getUnknownKanji("日本", known);
    expect(result.size).toBe(0);
  });

  it("returns unknown kanji not in the known set", () => {
    const known = new Set(["日"]);
    const result = getUnknownKanji("日本語", known);
    expect(result).toEqual(new Set(["本", "語"]));
  });

  it("does not duplicate kanji that appear multiple times", () => {
    const known = new Set<string>();
    const result = getUnknownKanji("日日日", known);
    expect(result).toEqual(new Set(["日"]));
  });

  it("ignores katakana and punctuation", () => {
    const known = new Set<string>();
    const result = getUnknownKanji("カタカナ！？。", known);
    expect(result.size).toBe(0);
  });
});
