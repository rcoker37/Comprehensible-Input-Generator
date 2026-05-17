import { describe, it, expect } from "vitest";
import { stripBold, cleanGeneratedText, isPunctuation } from "./text";

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

describe("isPunctuation", () => {
  it("matches Japanese punctuation", () => {
    for (const ch of [
      "、", "。", "！", "？", "「", "」", "『", "』", "（", "）", "・", "…",
    ]) {
      expect(isPunctuation(ch)).toBe(true);
    }
  });

  it("matches ASCII punctuation", () => {
    for (const ch of [",", ".", "!", "?", "(", ")", '"', "'", ":", ";"]) {
      expect(isPunctuation(ch)).toBe(true);
    }
  });

  it("matches the fullwidth tilde and wave dash", () => {
    expect(isPunctuation("～")).toBe(true);
    expect(isPunctuation("〜")).toBe(true);
  });

  it("does not match kana or kanji", () => {
    for (const ch of ["あ", "ア", "猫", "水", "が", "ん"]) {
      expect(isPunctuation(ch)).toBe(false);
    }
  });

  it("does not match the prolonged sound mark, iteration mark or 〇", () => {
    // ー / 々 / 〇 are letter/number categories — they form part of real
    // words (コーヒー, 人々) and must stay tappable.
    expect(isPunctuation("ー")).toBe(false);
    expect(isPunctuation("々")).toBe(false);
    expect(isPunctuation("〇")).toBe(false);
  });
});
