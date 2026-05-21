import { describe, it, expect } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import {
  isAllKanjiCanonicalNonUk,
  isNumberFragment,
  longestReadingSuffix,
  partitionReading,
} from "./storyWordIndex";

function wr(opts: {
  k?: { ent: string; i?: string[] }[];
  r?: { ent: string }[];
  pos?: string[];
  misc?: string[];
}): WordResult {
  return {
    id: 0,
    k: opts.k ?? [],
    r: opts.r ?? [],
    s: [{ pos: opts.pos ?? ["n"], misc: opts.misc }],
  } as unknown as WordResult;
}

describe("isNumberFragment", () => {
  it("accepts all-numeral and numeral+counter surfaces", () => {
    expect(isNumberFragment("一九二五")).toBe(true);
    expect(isNumberFragment("十四年")).toBe(true);
    expect(isNumberFragment("年")).toBe(true); // a bare counter
  });

  it("rejects surfaces with a non-number character", () => {
    expect(isNumberFragment("二年前")).toBe(false); // 前 is not a counter
    expect(isNumberFragment("東京")).toBe(false);
    expect(isNumberFragment("")).toBe(false);
  });
});

describe("longestReadingSuffix", () => {
  it("peels the counter reading off a fused number+counter ruby", () => {
    // 年's readings against the 二年前-minus-前 remainder.
    expect(longestReadingSuffix("にねん", ["ねん", "とし"])).toBe("ねん");
  });

  it("prefers the longest matching candidate", () => {
    expect(longestReadingSuffix("いちにち", ["ち", "にち"])).toBe("にち");
  });

  it("returns null when nothing matches", () => {
    expect(longestReadingSuffix("いちきゅうにご", ["ねん", "とし"])).toBe(null);
    expect(longestReadingSuffix("ねん", [""])).toBe(null);
  });
});

describe("partitionReading", () => {
  it("reconstructs a block ruby from a non-default piece reading", () => {
    // 山手線《やまのてせん》: 山手's default reading is the commoner やまて,
    // but the entry also lists やまのて — that's the one that fits.
    expect(
      partitionReading("やまのてせん", [["やまて", "やまのて"], ["せん"]])
    ).toEqual(["やまのて", "せん"]);
  });

  it("partitions a straightforwardly compositional block", () => {
    expect(
      partitionReading("ふつうせんきょほう", [["ふつう"], ["せんきょ"], ["ほう"]])
    ).toEqual(["ふつう", "せんきょ", "ほう"]);
  });

  it("backtracks past a piece reading that dead-ends the rest", () => {
    // Trying あ first strands おぞら (the next piece only reads ぞら); the
    // search must backtrack to the longer あお.
    expect(
      partitionReading("あおぞら", [["あ", "あお"], ["ぞら"]])
    ).toEqual(["あお", "ぞら"]);
  });

  it("returns null for a non-compositional 熟字訓 reading", () => {
    expect(
      partitionReading("さみだれ", [["ごがつ", "さつき"], ["あめ", "さめ"]])
    ).toBe(null);
  });
});

describe("isAllKanjiCanonicalNonUk", () => {
  it("returns true on an empty list (no-match surface routes to name branch)", () => {
    expect(isAllKanjiCanonicalNonUk([])).toBe(true);
  });

  it("returns true when every entry is kanji-canonical without `uk`", () => {
    // シンジ matches 神事/新字/鍼治 — all have a kanji form and no uk sense.
    expect(
      isAllKanjiCanonicalNonUk([
        wr({ k: [{ ent: "神事" }], r: [{ ent: "しんじ" }] }),
        wr({ k: [{ ent: "新字" }], r: [{ ent: "しんじ" }] }),
        wr({ k: [{ ent: "鍼治" }], r: [{ ent: "しんじ" }] }),
      ])
    ).toBe(true);
  });

  it("returns false when any entry carries `uk` (real katakana loanword)", () => {
    // ドイツ matches 独逸 with misc=uk — bucket 3, keep the JMdict match.
    expect(
      isAllKanjiCanonicalNonUk([
        wr({
          k: [{ ent: "独逸" }, { ent: "独乙" }],
          r: [{ ent: "ドイツ" }],
          misc: ["uk"],
        }),
      ])
    ).toBe(false);
  });

  it("returns false when an entry is kana-canonical (k=[])", () => {
    // レイ matches a kana-canonical entry — not a kanji-folding coincidence.
    expect(
      isAllKanjiCanonicalNonUk([wr({ k: [], r: [{ ent: "レイ" }] })])
    ).toBe(false);
  });

  it("treats `sK` kanji forms as if absent (same precedence as headwordFromHit)", () => {
    expect(
      isAllKanjiCanonicalNonUk([
        wr({ k: [{ ent: "乃", i: ["sK"] }], r: [{ ent: "の" }] }),
      ])
    ).toBe(false);
  });
});
