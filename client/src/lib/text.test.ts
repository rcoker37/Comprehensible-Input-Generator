import { describe, it, expect } from "vitest";
import { stripBold, getUnknownKanji } from "./text";

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
