import { describe, it, expect } from "vitest";
import { filterKanji } from "./client";
import type { Kanji } from "../types";

function makeKanji(overrides: Partial<Kanji> & { character: string }): Kanji {
  return {
    grade: 1,
    jlpt: 5,
    known: false,
    meanings: "",
    readings_on: "",
    readings_kun: "",
    ...overrides,
  };
}

const sampleKanji: Kanji[] = [
  makeKanji({ character: "日", grade: 1, jlpt: 5, meanings: "day, sun", readings_on: "ニチ", readings_kun: "ひ" }),
  makeKanji({ character: "本", grade: 1, jlpt: 4, meanings: "book, origin", readings_on: "ホン", readings_kun: "もと" }),
  makeKanji({ character: "語", grade: 2, jlpt: 5, meanings: "language, word", readings_on: "ゴ", readings_kun: "かた.る" }),
  makeKanji({ character: "嬉", grade: 8, jlpt: null, meanings: "glad, pleased", readings_on: "キ", readings_kun: "うれ.しい" }),
];

describe("filterKanji", () => {
  it("returns all kanji with no filters", () => {
    const result = filterKanji(sampleKanji, {});
    expect(result).toHaveLength(4);
  });

  it("filters by JLPT level", () => {
    const result = filterKanji(sampleKanji, { jlpt: [5] });
    expect(result.map((k) => k.character)).toEqual(["日", "語"]);
  });

  it("filters by multiple JLPT levels", () => {
    const result = filterKanji(sampleKanji, { jlpt: [4, 5] });
    expect(result.map((k) => k.character)).toEqual(["日", "本", "語"]);
  });

  it("excludes kanji with null JLPT when filtering by JLPT", () => {
    const result = filterKanji(sampleKanji, { jlpt: [5] });
    expect(result.map((k) => k.character)).not.toContain("嬉");
  });

  it("filters by grade", () => {
    const result = filterKanji(sampleKanji, { grade: [2] });
    expect(result.map((k) => k.character)).toEqual(["語"]);
  });

  it("filters by multiple grades", () => {
    const result = filterKanji(sampleKanji, { grade: [1, 8] });
    expect(result.map((k) => k.character)).toEqual(["日", "本", "嬉"]);
  });

  it("searches by meaning", () => {
    const result = filterKanji(sampleKanji, { search: "book" });
    expect(result.map((k) => k.character)).toEqual(["本"]);
  });

  it("searches by kanji character", () => {
    const result = filterKanji(sampleKanji, { search: "語" });
    expect(result.map((k) => k.character)).toEqual(["語"]);
  });

  it("searches by on reading", () => {
    const result = filterKanji(sampleKanji, { search: "ホン" });
    expect(result.map((k) => k.character)).toEqual(["本"]);
  });

  it("searches by kun reading", () => {
    const result = filterKanji(sampleKanji, { search: "もと" });
    expect(result.map((k) => k.character)).toEqual(["本"]);
  });

  it("search is case-insensitive for meanings", () => {
    const result = filterKanji(sampleKanji, { search: "GLAD" });
    expect(result.map((k) => k.character)).toEqual(["嬉"]);
  });

  it("multi-kanji search uses set-based matching", () => {
    const result = filterKanji(sampleKanji, { search: "日語" });
    expect(result.map((k) => k.character)).toEqual(["日", "語"]);
  });

  it("combines JLPT and grade filters", () => {
    const result = filterKanji(sampleKanji, { jlpt: [5], grade: [1] });
    expect(result.map((k) => k.character)).toEqual(["日"]);
  });

  it("returns empty array when no kanji match", () => {
    const result = filterKanji(sampleKanji, { search: "nonexistent" });
    expect(result).toHaveLength(0);
  });

  it("ignores empty filter arrays", () => {
    const result = filterKanji(sampleKanji, { jlpt: [], grade: [] });
    expect(result).toHaveLength(4);
  });
});
