import { describe, it, expect } from "vitest";
import { applyOccurrences, type OccurrenceRow } from "./applyOccurrences";
import { buildDisplaySegments, type DisplayParagraph } from "./storySegments";

function regroupedAsOneWord(text: string): DisplayParagraph[] {
  // Stand-in for what regroupWords does when it merges every char of a
  // sentence into one tap target — used to set up the case where a manual
  // override shrinks a previously-merged span.
  return [
    {
      sentences: [
        {
          start: 0,
          parts: [{ kind: "word", start: 0, end: text.length, surface: text }],
        },
      ],
    },
  ];
}

describe("applyOccurrences", () => {
  it("emits occurrence spans as word parts and fills the rest with chars", () => {
    const text = "公園に行く。";
    const base = buildDisplaySegments(text, []);
    const occurrences: OccurrenceRow[] = [
      {
        start: 0,
        end: 2,
        surface: "公園",
        headword: "公園",
        reading: "こうえん",
        manual: false,
      },
      {
        start: 2,
        end: 3,
        surface: "に",
        headword: "に",
        reading: "に",
        manual: false,
      },
      {
        start: 3,
        end: 5,
        surface: "行く",
        headword: "行く",
        reading: "いく",
        manual: false,
      },
    ];
    const result = applyOccurrences(base, occurrences, text, []);
    const parts = result[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({ kind: "word", start: 0, end: 2 });
    expect(parts[1]).toMatchObject({ kind: "word", start: 2, end: 3 });
    expect(parts[2]).toMatchObject({ kind: "word", start: 3, end: 5 });
    expect(parts[3]).toMatchObject({ kind: "char", offset: 5, char: "。" });
  });

  it("does not duplicate a part when a manual override shrinks a regrouped word", () => {
    // The bug: regrouper merged 朝ご飯 into one WordPart (0,3) but the only
    // occurrence is a manual (0,1) for 朝 (because the user shrank the
    // override region). The old part-walking algorithm emitted both the
    // (0,1) override AND the (0,3) original, visibly duplicating 朝 on the
    // page. The fix is to walk chars and let occurrences dictate their
    // span — the (1,3) remainder becomes char-level until the backfill
    // refills it.
    const text = "朝ご飯";
    const base = regroupedAsOneWord(text);
    const occurrences: OccurrenceRow[] = [
      {
        start: 0,
        end: 1,
        surface: "朝",
        headword: "朝",
        reading: "あさ",
        manual: true,
      },
    ];
    const result = applyOccurrences(base, occurrences, text, []);
    const parts = result[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ kind: "word", start: 0, end: 1 });
    expect(parts[1]).toMatchObject({ kind: "char", offset: 1, char: "ご" });
    expect(parts[2]).toMatchObject({ kind: "char", offset: 2, char: "飯" });
  });

  it("returns the input untouched when there are no occurrences", () => {
    const text = "朝ご飯";
    const base = regroupedAsOneWord(text);
    const result = applyOccurrences(base, [], text, []);
    expect(result).toBe(base);
  });

  it("preserves annotations in gaps between occurrences", () => {
    // 公《こう》園《えん》に — only 公園 is indexed as one occurrence; the
    // に in the gap should still render as a CharPart.
    const text = "公園に";
    const annotations = [
      { start: 0, end: 1, reading: "こう" },
      { start: 1, end: 2, reading: "えん" },
    ];
    const base = buildDisplaySegments(text, annotations);
    const occurrences: OccurrenceRow[] = [
      {
        start: 0,
        end: 2,
        surface: "公園",
        headword: "公園",
        reading: "こうえん",
        manual: false,
      },
    ];
    const result = applyOccurrences(base, occurrences, text, annotations);
    const parts = result[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      kind: "word",
      start: 0,
      end: 2,
      rubies: [
        { start: 0, end: 1, reading: "こう" },
        { start: 1, end: 2, reading: "えん" },
      ],
    });
    expect(parts[1]).toMatchObject({ kind: "char", offset: 2, char: "に" });
  });

  it("emits annotated parts in gaps when annotation falls outside any occurrence", () => {
    // ご飯《はん》 with override on (0,1) leaving 飯's annotation in the
    // gap — should render as an AnnotatedPart not raw CharPart.
    const text = "朝飯";
    const annotations = [{ start: 1, end: 2, reading: "はん" }];
    const base = buildDisplaySegments(text, annotations);
    const occurrences: OccurrenceRow[] = [
      {
        start: 0,
        end: 1,
        surface: "朝",
        headword: "朝",
        reading: "あさ",
        manual: true,
      },
    ];
    const result = applyOccurrences(base, occurrences, text, annotations);
    const parts = result[0]!.sentences[0]!.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ kind: "word", start: 0, end: 1 });
    expect(parts[1]).toMatchObject({
      kind: "annotated",
      start: 1,
      end: 2,
      reading: "はん",
    });
  });
});
