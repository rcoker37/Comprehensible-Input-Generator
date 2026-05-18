import { describe, it, expect } from "vitest";
import {
  isNumberFragment,
  longestReadingSuffix,
  partitionReading,
} from "./storyWordIndex";

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
