import { describe, it, expect } from "vitest";
import { isNumberFragment, longestReadingSuffix } from "./storyWordIndex";

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
