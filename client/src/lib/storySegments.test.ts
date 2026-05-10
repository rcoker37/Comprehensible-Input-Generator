import { describe, it, expect } from "vitest";
import { buildDisplaySegments } from "./storySegments";

describe("buildDisplaySegments", () => {
  it("emits one char part per character for un-annotated kanji runs", () => {
    // The motivating bug: tapping any character of 千九百年代 was collapsing to 千.
    // With per-character parts each tap maps to a distinct offset.
    const paras = buildDisplaySegments("千九百年代", []);
    expect(paras).toHaveLength(1);
    expect(paras[0]!.sentences).toHaveLength(1);
    const parts = paras[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(5);
    expect(parts.map((p) => p.kind)).toEqual([
      "char",
      "char",
      "char",
      "char",
      "char",
    ]);
    expect(parts.map((p) => (p.kind === "char" ? p.offset : -1))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(parts.map((p) => (p.kind === "char" ? p.char : ""))).toEqual([
      "千",
      "九",
      "百",
      "年",
      "代",
    ]);
  });

  it("emits a single annotated part for kanji runs covered by an annotation", () => {
    const text = "二人は公園";
    const anns = [
      { start: 0, end: 2, reading: "ふたり" },
      { start: 3, end: 5, reading: "こうえん" },
    ];
    const paras = buildDisplaySegments(text, anns);
    const parts = paras[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      kind: "annotated",
      start: 0,
      end: 2,
      surface: "二人",
      reading: "ふたり",
    });
    expect(parts[1]).toEqual({ kind: "char", offset: 2, char: "は" });
    expect(parts[2]).toEqual({
      kind: "annotated",
      start: 3,
      end: 5,
      surface: "公園",
      reading: "こうえん",
    });
  });

  it("splits sentences on terminators with closer characters attached", () => {
    const text = "「これは。」明日も来る！";
    const paras = buildDisplaySegments(text, []);
    expect(paras).toHaveLength(1);
    const sentences = paras[0]!.sentences;
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.audioIdx).toBe(0);
    expect(sentences[0]!.start).toBe(0); // 「 starts at 0; closers don't reset start
    // First sentence: 「これは。」 — 5 chars (no trailing 」 dropped)
    expect(sentences[0]!.parts.map((p) => (p.kind === "char" ? p.char : "?")))
      .toEqual(["「", "こ", "れ", "は", "。", "」"]);
    expect(sentences[1]!.audioIdx).toBe(1);
    expect(sentences[1]!.start).toBe(6); // 明 starts after 「これは。」
    expect(sentences[1]!.parts.map((p) => (p.kind === "char" ? p.char : "?")))
      .toEqual(["明", "日", "も", "来", "る", "！"]);
  });

  it("breaks paragraphs on blank lines", () => {
    const text = "一行目。\n\n二行目。";
    const paras = buildDisplaySegments(text, []);
    expect(paras).toHaveLength(2);
    expect(paras[0]!.sentences[0]!.audioIdx).toBe(0);
    expect(paras[1]!.sentences[0]!.audioIdx).toBe(1);
    expect(paras[1]!.sentences[0]!.start).toBe(6); // after "一行目。\n\n"
  });

  it("treats a single newline as a sentence break, not a paragraph break", () => {
    const text = "一文目\n二文目";
    const paras = buildDisplaySegments(text, []);
    expect(paras).toHaveLength(1);
    expect(paras[0]!.sentences).toHaveLength(2);
  });

  it("does not start a new sentence on standalone closer characters at line start", () => {
    // Edge case: when armed and the first char of a new sentence is a closer,
    // we don't consume the arming — the next non-closer char gets the bookmark.
    const text = "「こんにちは」";
    const paras = buildDisplaySegments(text, []);
    expect(paras[0]!.sentences[0]!.start).toBe(0); // 「 isn't a closer
  });

  it("returns no paragraphs for empty input", () => {
    expect(buildDisplaySegments("", [])).toEqual([]);
  });

  it("returns no paragraphs for whitespace-only input", () => {
    expect(buildDisplaySegments("\n  \n", [])).toEqual([]);
  });

  it("preserves character offsets across multiple paragraphs", () => {
    // Verifies offsets are absolute positions in the input text, not relative
    // to each paragraph — the popover lookup needs absolute offsets to slice
    // cleanText[start:end] for the explanation thread key.
    const text = "ABC\n\nDEF";
    const paras = buildDisplaySegments(text, []);
    expect(paras[1]!.sentences[0]!.parts[0]).toMatchObject({
      kind: "char",
      offset: 5,
      char: "D",
    });
  });
});
